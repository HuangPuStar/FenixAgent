// web/__tests__/cloud-drive-upload.test.ts
// 分片上传纯逻辑：切片、续传 offset、退避重试、410 重建会话、finalize 幂等重试。
//
// 这些分支在组件测试里很难可靠复现（需要控制网络失败点与「响应丢失但分片已落盘」的时序），
// 因此编排层被设计成注入端口 + 注入 delay 的纯函数：本文件用内存端口把每条路径钉住，
// 页面只负责展示进度与错误。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { type CloudDriveUploadPort, runChunkedUpload, type UploadSource } from "../lib/upload";
import type { CloudDriveUpload, CloudDriveUploadResult, CloudDriveUploadStatus } from "../types/cloud-drive";

/** 轻量文件替身：只实现编排层用到的 size 与 slice，避免构造真实字节。 */
function createSource(size: number, name = "report.pdf"): UploadSource {
  return {
    name,
    size,
    type: "application/pdf",
    slice: (start, end) => ({ size: end - start }) as unknown as Blob,
  };
}

interface FakePortOptions {
  /** 每个新会话的起始 offset（模拟服务端已接收一部分）。 */
  initialOffset?: number;
  /** 第 n 次 send（从 1 起）返回错误；返回 null 表示成功。 */
  failSend?: (attempt: number) => unknown;
  /** send 失败时把服务端 offset 推进到的位置（模拟「分片已落盘但响应丢失」）。 */
  failureOffset?: number;
  /** 第 n 次 finalize 返回错误。 */
  failFinalize?: (attempt: number) => unknown;
}

/** 内存端口：记录全部调用，并按配置注入失败。 */
class FakePort implements CloudDriveUploadPort {
  readonly sends: { uploadId: string; offset: number; length: number }[] = [];
  readonly finalized: string[] = [];
  readonly abandoned: string[] = [];
  beginCount = 0;
  finalizeCount = 0;
  private sessionSeq = 0;
  private readonly offsets = new Map<string, number>();

  constructor(private readonly options: FakePortOptions = {}) {}

  async begin(): Promise<CloudDriveUpload> {
    this.beginCount += 1;
    const uploadId = `upload-${this.sessionSeq + 1}`;
    this.sessionSeq += 1;
    this.offsets.set(uploadId, this.options.initialOffset ?? 0);
    return { uploadId, fileId: "file-1", operationId: "op-1", status: "uploading", expiresAt: null };
  }

  async status(uploadId: string): Promise<CloudDriveUploadStatus> {
    return { uploadId, offset: this.offsets.get(uploadId) ?? 0, length: 0 };
  }

  async send(uploadId: string, offset: number, chunk: Blob): Promise<CloudDriveUploadStatus> {
    this.sends.push({ uploadId, offset, length: chunk.size });
    const failure = this.options.failSend?.(this.sends.length);
    if (failure) {
      if (this.options.failureOffset !== undefined) this.offsets.set(uploadId, this.options.failureOffset);
      throw failure;
    }
    const next = offset + chunk.size;
    this.offsets.set(uploadId, next);
    return { uploadId, offset: next, length: next };
  }

  async finalize(uploadId: string): Promise<CloudDriveUploadResult> {
    this.finalizeCount += 1;
    const failure = this.options.failFinalize?.(this.finalizeCount);
    if (failure) throw failure;
    this.finalized.push(uploadId);
    return { fileId: "file-1", versionId: "version-1", status: "saved" };
  }

  async abandon(uploadId: string): Promise<void> {
    this.abandoned.push(uploadId);
  }
}

const noDelay = async () => {};

describe("分片上传编排", () => {
  // 业务意图：4 MiB 分片只是默认值，编排必须按 chunkBytes 精确切分并在每片后用服务端返回的 offset 前进。
  test("按分片大小切分、逐片上报并在完成后 finalize", async () => {
    const port = new FakePort();
    const progress: number[] = [];

    const result = await runChunkedUpload(port, {
      parentId: null,
      file: createSource(10),
      chunkBytes: 4,
      delay: noDelay,
      onProgress: (uploaded) => progress.push(uploaded),
    });

    expect(port.beginCount).toBe(1);
    expect(port.sends.map((send) => [send.offset, send.length])).toEqual([
      [0, 4],
      [4, 4],
      [8, 2],
    ]);
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(port.finalized).toEqual(["upload-1"]);
    expect(result).toEqual({
      uploadId: "upload-1",
      result: { fileId: "file-1", versionId: "version-1", status: "saved" },
    });
  });

  // 业务意图：续传起点必须来自 GET /uploads/:id 的 offset，不是本地计数——断点可能发生在响应丢失之后。
  test("续传从服务端 offset 开始，不重传已接收的字节", async () => {
    const port = new FakePort({ initialOffset: 5 });

    await runChunkedUpload(port, {
      parentId: null,
      file: createSource(10),
      chunkBytes: 4,
      delay: noDelay,
    });

    expect(port.sends.map((send) => [send.offset, send.length])).toEqual([
      [5, 4],
      [9, 1],
    ]);
  });

  // 业务意图：分片失败后先退避、再以服务端 offset 续传；服务端可能已接收部分字节，必须从真相位置继续。
  test("分片失败后按服务端 offset 续传而不是重传同一段", async () => {
    const port = new FakePort({
      failSend: (attempt) => (attempt === 1 ? new ApiError("网络异常，请检查连接", "NETWORK_ERROR") : null),
      failureOffset: 2,
    });

    await runChunkedUpload(port, {
      parentId: null,
      file: createSource(10),
      chunkBytes: 4,
      delay: noDelay,
    });

    expect(port.sends.map((send) => [send.offset, send.length])).toEqual([
      [0, 4],
      [2, 4],
      [6, 4],
    ]);
    expect(port.finalized).toEqual(["upload-1"]);
  });

  // 业务意图：410 表示会话已结束（finalize/abandon 之后或过期），同一会话不可续传，只能重建一次后重传。
  // 这里同时让幂等 finalize 失败（会话不是「已提交」而是真的不可用），才会走到重建分支。
  test("会话 410 且幂等 finalize 也失败时重建会话并从头上传", async () => {
    const port = new FakePort({
      failSend: (attempt) =>
        attempt === 1 ? new ApiError("上传会话已结束或不可续传", "CLOUD_DRIVE_UPLOAD_GONE") : null,
      failFinalize: (attempt) =>
        attempt === 1 ? new ApiError("上传会话不存在或已结束", "CLOUD_DRIVE_UPLOAD_NOT_FOUND") : null,
    });

    const result = await runChunkedUpload(port, {
      parentId: null,
      file: createSource(6),
      chunkBytes: 4,
      delay: noDelay,
    });

    expect(port.beginCount).toBe(2);
    expect(port.sends.map((send) => send.uploadId)).toEqual(["upload-1", "upload-2", "upload-2"]);
    expect(port.sends.map((send) => send.offset)).toEqual([0, 0, 4]);
    expect(result.uploadId).toBe("upload-2");
    expect(port.finalized).toEqual(["upload-2"]);
  });

  // 业务意图：finalize 的成功响应丢失后再重试，GET status 会返回 410；此时先做幂等 finalize
  // 拿回 saved，而不是新建会话再传一遍——否则同名文件会被重复创建。
  test("会话已结束但 finalize 幂等成功时不再重建会话", async () => {
    const port = new FakePort({
      failSend: () => new ApiError("上传会话已结束或不可续传", "CLOUD_DRIVE_UPLOAD_GONE"),
    });

    const result = await runChunkedUpload(port, {
      parentId: null,
      file: createSource(6),
      chunkBytes: 4,
      delay: noDelay,
    });

    expect(port.beginCount).toBe(1);
    expect(port.finalizeCount).toBe(1);
    expect(port.finalized).toEqual(["upload-1"]);
    expect(result.uploadId).toBe("upload-1");
    expect(result.result.status).toBe("saved");
  });

  // 业务意图：配额/输入类失败重试也不会成功，必须立即失败，避免把 413/422 变成无限退避。
  test("非可重试错误不重试，直接抛出", async () => {
    const port = new FakePort({
      failSend: () => new ApiError("文件超出存储配额或大小上限", "CLOUD_DRIVE_PAYLOAD_TOO_LARGE"),
    });

    await expect(
      runChunkedUpload(port, { parentId: null, file: createSource(8), chunkBytes: 4, delay: noDelay }),
    ).rejects.toMatchObject({ code: "CLOUD_DRIVE_PAYLOAD_TOO_LARGE" });
    expect(port.sends.length).toBe(1);
    expect(port.beginCount).toBe(1);
  });

  // 业务意图：用户取消不是失败，不能吞掉；编排层必须让 AbortError 原样冒泡，页面据此展示「已取消」。
  test("AbortSignal 已取消时不发分片并抛 AbortError", async () => {
    const port = new FakePort();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runChunkedUpload(port, {
        parentId: null,
        file: createSource(8),
        chunkBytes: 4,
        signal: controller.signal,
        delay: noDelay,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(port.sends).toEqual([]);
  });

  // 业务意图：request 层把「外部取消」也归成 NETWORK_ERROR；若只看 code 不看 signal，
  // 取消会被当成可重试的网络抖动继续传完。这条钉住「取消立即生效、不重试」。
  test("上传过程中取消时不再重试，以 AbortError 结束", async () => {
    const controller = new AbortController();
    const port = new FakePort({
      failSend: () => {
        controller.abort();
        return new ApiError("请求超时或已取消", "NETWORK_ERROR");
      },
    });

    await expect(
      runChunkedUpload(port, {
        parentId: null,
        file: createSource(8),
        chunkBytes: 4,
        signal: controller.signal,
        delay: noDelay,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(port.sends.length).toBe(1);
    expect(port.finalizeCount).toBe(0);
  });

  // 业务意图：finalize 是幂等的，409 表示操作仍在进行；稍后重试可收敛，不应把用户上传判死。
  test("finalize 遇到 409 冲突时重试并成功", async () => {
    const port = new FakePort({
      failFinalize: (attempt) =>
        attempt === 1 ? new ApiError("目标已存在或文件已变化", "CLOUD_DRIVE_CONFLICT") : null,
    });

    const result = await runChunkedUpload(port, {
      parentId: null,
      file: createSource(1),
      chunkBytes: 4,
      delay: noDelay,
    });

    expect(port.finalizeCount).toBe(2);
    expect(result.result.status).toBe("saved");
  });
});
