/**
 * 分片上传（TUS 代理）的纯编排：分片切分、续传 offset、退避重试、410 重建会话。
 *
 * 为什么独立于 React 与 API client：这是本功能里唯一有状态机的地方（offset 必须永远以服务端为准），
 * 用注入的端口 + 注入的 `delay` 就能在无网络、无组件的测试里覆盖续传与重建分支。真正的
 * `@fenix/web-runtime` 接线在 `../hooks/use-cloud-drive-uploads.ts`。
 *
 * 协议约束（见 `packages/resources/cloud-drive/README.md`）：
 * - 每个分片必须带 `Upload-Offset`，且分片不能为空；浏览器自动写 `Content-Length`。
 * - 续传起点永远来自 `status()`（服务端已接收字节数），不是本地计数——分片可能已落盘但响应丢失。
 * - 会话已结束（410 `CLOUD_DRIVE_UPLOAD_GONE`）或不存在（404 `CLOUD_DRIVE_UPLOAD_NOT_FOUND`）
 *   不能重试同一会话，只能重建一次会话从头再传。
 */

import type { CloudDriveUpload, CloudDriveUploadResult, CloudDriveUploadStatus } from "../types/cloud-drive";
import { isAbortError, isRetryableCloudDriveError, isUploadGone, isUploadMissing } from "./errors";

/** 服务端建议分片：4 MiB（CloudDrive 单请求上限 64 MiB，宿主 body 上限 108 MiB）。 */
export const DEFAULT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** 可被分片上传的本地文件形状；`File` 结构上满足它，测试不必构造真实 `File`。 */
export interface UploadSource {
  name: string;
  size: number;
  type?: string;
  slice(start: number, end: number): Blob;
}

/** 上传编排依赖的服务端操作；实现方负责 `unwrap()`，本模块只消费成功值/异常。 */
export interface CloudDriveUploadPort {
  begin(input: {
    parentId: string | null;
    name: string;
    sizeBytes: number;
    contentType?: string;
  }): Promise<CloudDriveUpload>;
  status(uploadId: string): Promise<CloudDriveUploadStatus>;
  send(uploadId: string, offset: number, chunk: Blob): Promise<CloudDriveUploadStatus>;
  finalize(uploadId: string): Promise<CloudDriveUploadResult>;
  abandon(uploadId: string): Promise<void>;
}

export interface RunChunkedUploadOptions {
  /** 目标目录；根目录用 `null`。 */
  parentId: string | null;
  file: UploadSource;
  signal?: AbortSignal;
  /** 分片大小；默认 {@link DEFAULT_UPLOAD_CHUNK_BYTES}。 */
  chunkBytes?: number;
  /** 单个分片的额外重试次数（不含首次）；默认 2。 */
  maxChunkRetries?: number;
  /** 会话失效后允许重建会话的次数；默认 1。 */
  maxSessionRestarts?: number;
  /** 断点续传的会话 ID（重试时由调用方保留）；省略则新建会话。 */
  resumeUploadId?: string | null;
  /** 已接收字节数回调；续传开始时立即回调一次。 */
  onProgress?: (uploadedBytes: number) => void;
  /** 新会话建立时回调，调用方据此保存可续传的 uploadId。 */
  onSessionChange?: (uploadId: string) => void;
  /** 退避等待；测试注入空实现以跳过真实计时。 */
  delay?: (ms: number) => Promise<void>;
}

export interface RunChunkedUploadResult {
  uploadId: string;
  result: CloudDriveUploadResult;
}

const DEFAULT_MAX_CHUNK_RETRIES = 2;
const DEFAULT_MAX_SESSION_RESTARTS = 1;
/** 退避上限：服务端 429/503 的恢复窗口通常是秒级。 */
const MAX_BACKOFF_MS = 2_000;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("上传已取消", "AbortError");
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 250 * 2 ** (attempt - 1));
}

/**
 * 上传一个文件到目标目录，返回最终的会话 ID 与提交结果。
 *
 * 失败时抛原始错误（`ApiError` / `AbortError` / 传输层异常），由调用方决定展示与是否重新入队。
 * 已建立的会话不会在失败时被 abandon：保留 `uploadId` 才能让「重试」走续传而不是从头再来。
 */
export async function runChunkedUpload(
  port: CloudDriveUploadPort,
  options: RunChunkedUploadOptions,
): Promise<RunChunkedUploadResult> {
  const {
    parentId,
    file,
    signal,
    chunkBytes = DEFAULT_UPLOAD_CHUNK_BYTES,
    maxChunkRetries = DEFAULT_MAX_CHUNK_RETRIES,
    maxSessionRestarts = DEFAULT_MAX_SESSION_RESTARTS,
    onProgress,
    onSessionChange,
    delay = defaultDelay,
  } = options;

  if (chunkBytes <= 0) throw new Error("分片大小必须为正数");

  const beginSession = async (): Promise<string> => {
    const session = await port.begin({
      parentId,
      name: file.name,
      sizeBytes: file.size,
      contentType: file.type || undefined,
    });
    onSessionChange?.(session.uploadId);
    return session.uploadId;
  };

  let uploadId = options.resumeUploadId ?? (await beginSession());
  let restarts = 0;

  for (;;) {
    try {
      const result = await transferSession(port, {
        uploadId,
        file,
        chunkBytes,
        maxChunkRetries,
        signal,
        onProgress,
        delay,
      });
      return { uploadId, result };
    } catch (error) {
      // 外部取消在 request 层表现为 NETWORK_ERROR（不是 AbortError）；必须先看 signal，
      // 否则「取消」会被当成可重试的网络抖动，继续把分片传完。
      throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      const sessionGone = isUploadGone(error) || isUploadMissing(error);
      if (!sessionGone || restarts >= maxSessionRestarts) throw error;

      // 会话已结束不一定是失败：上一轮 finalize 可能已在服务端成功，只是响应丢失。
      // finalize 幂等，先重试一次能拿回 saved，避免重建会话后上传出第二份同名文件。
      const recovered = await tryRecoverFinalized(port, uploadId);
      if (recovered) return { uploadId, result: recovered };

      restarts += 1;
      uploadId = await beginSession();
    }
  }
}

/** 会话已结束时的幂等 finalize 探测；失败返回 null，由调用方决定重建会话。 */
async function tryRecoverFinalized(
  port: CloudDriveUploadPort,
  uploadId: string,
): Promise<CloudDriveUploadResult | null> {
  try {
    return await port.finalize(uploadId);
  } catch {
    return null;
  }
}

interface TransferSessionOptions {
  uploadId: string;
  file: UploadSource;
  chunkBytes: number;
  maxChunkRetries: number;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number) => void;
  delay: (ms: number) => Promise<void>;
}

/** 单个会话内的分片循环；会话级失败（410/404）交给外层决定是否重建。 */
async function transferSession(
  port: CloudDriveUploadPort,
  options: TransferSessionOptions,
): Promise<CloudDriveUploadResult> {
  const { uploadId, file, chunkBytes, maxChunkRetries, signal, onProgress, delay } = options;

  const status = await port.status(uploadId);
  let offset = Math.min(status.offset, file.size);
  onProgress?.(offset);

  while (offset < file.size) {
    throwIfAborted(signal);
    const chunk = file.slice(offset, Math.min(offset + chunkBytes, file.size));

    let attempt = 0;
    for (;;) {
      try {
        const next = await port.send(uploadId, offset, chunk);
        offset = Math.min(next.offset, file.size);
        onProgress?.(offset);
        break;
      } catch (error) {
        throwIfAborted(signal);
        if (isAbortError(error)) throw error;
        if (isUploadGone(error) || isUploadMissing(error)) throw error;
        if (!isRetryableCloudDriveError(error) || attempt >= maxChunkRetries) throw error;

        attempt += 1;
        await delay(backoffMs(attempt));
        throwIfAborted(signal);
        // 分片可能已在服务端落盘但响应丢失：重试前以服务端 offset 为准，避免重复写同一段。
        offset = Math.min((await port.status(uploadId)).offset, file.size);
        onProgress?.(offset);
        if (offset >= file.size) break;
      }
    }
  }

  return finalizeWithRetry(port, uploadId, delay);
}

/**
 * finalize 的幂等重试：409 `CLOUD_DRIVE_CONFLICT` 表示操作仍在进行，稍后重试可收敛；
 * 其余失败（含 410）原样抛出，由外层按会话失效处理。
 */
async function finalizeWithRetry(
  port: CloudDriveUploadPort,
  uploadId: string,
  delay: (ms: number) => Promise<void>,
): Promise<CloudDriveUploadResult> {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await port.finalize(uploadId);
    } catch (error) {
      const conflict = error instanceof Error && "code" in error && error.code === "CLOUD_DRIVE_CONFLICT";
      if (!conflict || attempt >= maxAttempts) throw error;
      await delay(backoffMs(attempt));
    }
  }
}
