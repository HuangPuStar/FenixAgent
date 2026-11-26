/** 本地与远程文件执行后端，共享条件写规则；门面负责授权并选择后端。 */

import { Readable } from "node:stream";
import type { FileOpOptions } from "../transport/file-ws-requests";
import { assertVersionMatch } from "./file-preconditions";
import {
  type FileReadOptions,
  type FileUploadOptions,
  type FileWriteOptions,
  REMOTE_UPLOAD_MAX_BYTES,
  type ReadMode,
  type ReadResult,
  type StatResult,
  type TreeResult,
  type UploadFileInput,
  type UploadResult,
  type WriteResult,
} from "./file-types";
import { LocalBackend } from "./local-file-backend";
import {
  getRemoteMachineId,
  remoteDeleteFile,
  remoteListDir,
  remoteMkdir,
  remoteReadBinaryFile,
  remoteReadFile,
  remoteRename,
  remoteStat,
  remoteTree,
  remoteUploadFiles,
  remoteWriteFile,
  remoteZip,
} from "./remote-file-service";
import { type FileEntry, shouldHideEntry, shouldHidePath } from "./workspace-fs";

export { setLocalUploadBeforeWriteHookForTest } from "./local-file-backend";
// ── BackEnd 统一执行接口（§2.3）─────────────────────────────────

export interface BackEnd {
  /** 能力上限显式声明（§2.4 能力不对称条款）；W8b 实施检查 */
  readonly uploadMaxBytes: number;
  tree(envId: string, path?: string, connectionWaitDeadline?: number): Promise<TreeResult>;
  list(envId: string, path: string): Promise<FileEntry[]>;
  read(envId: string, path: string, mode: ReadMode, options?: FileReadOptions): Promise<ReadResult>;
  write(envId: string, path: string, content: string, options?: FileWriteOptions): Promise<WriteResult>;
  upload(envId: string, dir: string, files: UploadFileInput[], options?: FileUploadOptions): Promise<UploadResult>;
  delete(envId: string, path: string, options?: FileWriteOptions): Promise<void>;
  mkdir(envId: string, path: string, options?: FileWriteOptions): Promise<void>;
  rename(envId: string, oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void>;
  stat(envId: string, path: string, options?: FileReadOptions): Promise<StatResult>;
  downloadZip(envId: string, path: string): Promise<NodeJS.ReadableStream>;
}

/** 远程实现：包装 remote-file-service（machineId 由门面路由决策注入） */
class RemoteBackend implements BackEnd {
  readonly uploadMaxBytes = REMOTE_UPLOAD_MAX_BYTES;
  constructor(private machineId: string) {}

  /** options → file_op 帧参数（opId/actorId/source 透传，§7.2 / P2-18）；ifMatch 不
   *  进帧（机器端执行点无版本概念），比对在服务端经 remoteStat 完成 */
  private remoteOptions(options?: FileWriteOptions): FileOpOptions | undefined {
    const { opId, actorId, source } = options ?? {};
    if (!opId && !actorId && !source) return;
    return { ...(opId ? { opId } : {}), ...(actorId ? { actorId } : {}), ...(source ? { source } : {}) };
  }

  /** 远程 If-Match 比对：remoteStat（有 modifiedAt）派生当前 ETag 后比对。stat 失败
   *  保持原始错误传播（断连/机器端错误 → 503 语义，不吞错）；远程 stat 无
   *  not-found 语义（机器端错误码统一 error），目标缺失与服务不可用无法区分，
   *  故仅 stat 成功时才有版本冲突判定（诚实边界，§4.4）。 */
  private async assertRemoteIfMatch(envId: string, path: string, ifMatch: string | undefined): Promise<void> {
    if (ifMatch === undefined) return;
    const r = await remoteStat(this.machineId, envId, path);
    assertVersionMatch(ifMatch, path, r.size, r.modifiedAt);
  }

  async tree(envId: string, _path?: string, connectionWaitDeadline?: number): Promise<TreeResult> {
    const result = await remoteTree(this.machineId, envId, connectionWaitDeadline);
    const paths = result.paths.filter((path) => !shouldHidePath(path));
    const visiblePaths = new Set(paths);
    const mtimes = result.mtimes
      ? Object.fromEntries(Object.entries(result.mtimes).filter(([path]) => !shouldHidePath(path)))
      : undefined;
    const errors = result.errors?.filter(({ path }) => !shouldHidePath(path));
    const sizes = result.sizes
      ? Object.fromEntries(Object.entries(result.sizes).filter(([path]) => visiblePaths.has(path)))
      : undefined;
    return { paths, ...(mtimes ? { mtimes } : {}), ...(sizes ? { sizes } : {}), ...(errors?.length ? { errors } : {}) };
  }
  async list(envId: string, path: string): Promise<FileEntry[]> {
    const entries = await remoteListDir(this.machineId, envId, path);
    return entries.filter((entry) => !shouldHideEntry(entry.path, entry.name));
  }
  async read(envId: string, path: string, mode: ReadMode, options?: FileReadOptions): Promise<ReadResult> {
    if (!options?.includeMtime || options.includeVersion) return this.readContent(envId, path, mode, options);
    const before = await remoteStat(this.machineId, envId, path);
    const result = await this.readContent(envId, path, mode, options);
    let after: Awaited<ReturnType<typeof remoteStat>>;
    try {
      after = await remoteStat(this.machineId, envId, path);
    } catch (error) {
      if (result.type === "binary" && result.stream instanceof Readable) result.stream.destroy();
      throw error;
    }
    // 分离的 stat/read 不是原子快照；只有前后元数据一致才能将修改时间绑定到正文。
    if (
      !before.isDirectory &&
      !after.isDirectory &&
      Number.isFinite(before.modifiedAt) &&
      before.modifiedAt > 0 &&
      before.modifiedAt === after.modifiedAt &&
      before.size === result.size &&
      after.size === result.size
    )
      return { ...result, mtimeMs: before.modifiedAt };
    return result;
  }
  /** 读取远端正文，保留 auto 的文本探测与二进制回退语义。 */
  private async readContent(
    envId: string,
    path: string,
    mode: ReadMode,
    options?: FileReadOptions,
  ): Promise<ReadResult> {
    if (mode === "binary") return this.readBinary(envId, path, options);
    try {
      const r = await remoteReadFile(this.machineId, envId, path, options);
      return {
        type: "text",
        name: r.name,
        path: r.path,
        content: r.content,
        size: Buffer.byteLength(r.content),
        encoding: r.encoding,
        ...(r.version ? { version: r.version } : {}),
      };
    } catch (err) {
      // auto 模式：文本失败回退二进制（现状 fs.ts 语义）；text 模式失败向上抛（W13' 明确错误）
      if (mode !== "auto") throw err;
      return this.readBinary(envId, path, options);
    }
  }
  private async readBinary(envId: string, path: string, options?: FileReadOptions): Promise<ReadResult> {
    const r = await remoteReadBinaryFile(this.machineId, envId, path, options);
    const content = Buffer.from(r.data, "base64");
    return {
      type: "binary",
      name: r.name,
      path: r.path,
      size: content.byteLength,
      mimeType: r.mimeType,
      ...(r.version ? { version: r.version } : {}),
      // 远程走 base64 单帧（现状语义）；流由内存缓冲构造，与现状 buffer 等价
      stream: Readable.from(content),
    };
  }
  async write(envId: string, path: string, content: string, options?: FileWriteOptions): Promise<WriteResult> {
    await this.assertRemoteIfMatch(envId, path, options?.ifMatch);
    return remoteWriteFile(
      this.machineId,
      envId,
      path,
      content,
      { ...this.remoteOptions(options), expectedVersion: options?.expectedVersion },
      options?.createOnly,
    );
  }
  async upload(
    envId: string,
    dir: string,
    files: UploadFileInput[],
    options?: FileUploadOptions,
  ): Promise<UploadResult> {
    await this.assertRemoteIfMatch(envId, dir, options?.ifMatch);
    return remoteUploadFiles(
      this.machineId,
      envId,
      dir,
      files.map((f) => ({
        name: f.name,
        content: Buffer.from(f.content).toString("base64"),
        relativePath: f.relativePath ?? f.name,
        ...(f.expectedVersion !== undefined ? { expectedVersion: f.expectedVersion } : {}),
      })),
      { ...this.remoteOptions(options), overwrite: options?.overwrite, signal: options?.signal },
    );
  }
  async delete(envId: string, path: string, options?: FileWriteOptions): Promise<void> {
    await this.assertRemoteIfMatch(envId, path, options?.ifMatch);
    await remoteDeleteFile(this.machineId, envId, path, this.remoteOptions(options));
  }
  async mkdir(envId: string, path: string, options?: FileWriteOptions): Promise<void> {
    await this.assertRemoteIfMatch(envId, path, options?.ifMatch);
    await remoteMkdir(this.machineId, envId, path, this.remoteOptions(options));
  }
  async rename(envId: string, oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void> {
    await this.assertRemoteIfMatch(envId, oldPath, options?.ifMatch);
    await remoteRename(this.machineId, envId, oldPath, newPath, this.remoteOptions(options));
  }
  async stat(envId: string, path: string, options?: FileReadOptions): Promise<StatResult> {
    const r = await remoteStat(this.machineId, envId, path, options);
    return {
      size: r.size,
      isDirectory: r.isDirectory,
      modifiedAt: r.modifiedAt,
      ...(r.version ? { version: r.version } : {}),
    };
  }
  async downloadZip(envId: string, path: string): Promise<NodeJS.ReadableStream> {
    // 远程整包回传后解码，路由负责向浏览器输出文件流。
    const base64 = await remoteZip(this.machineId, envId, path);
    return Readable.from(Buffer.from(base64, "base64"));
  }
}

// ── BackEnd 路由决策（§3 回退链，门面 resolveExecutionBackend）─────────
/** BackEnd 路由决策（§3 回退链）：agentConfig.machineId → RCS_DEFAULT_MACHINE_ID
 *  → null 本地。配了 machine 但 file-ws 未连接时 getRemoteMachineId 抛 503，
 *  拒绝静默回退。决策不缓存，每次操作实时判定（连接状态会变）。 */
export async function resolveExecutionBackend(envId: string, connectionWaitDeadline?: number): Promise<BackEnd> {
  const machineId = await getRemoteMachineId(envId, connectionWaitDeadline);
  return machineId ? new RemoteBackend(machineId) : new LocalBackend();
}
