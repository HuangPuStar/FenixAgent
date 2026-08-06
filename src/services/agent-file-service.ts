// AgentFileService —— 统一文件执行面（W5a，P1-7a）
// 路由层与执行后端之间的唯一门面：认证校验（gate）→ 路由决策（machineId
// 回退链）→ 统一路径校验 → BackEnd 执行 → 统一错误映射。fs.ts 双分支（W5b）
// 收敛后路由层只调本门面；后续波次小改（W6 校验接 validator / W7 事件发布 /
// W12b 启用 opId/ifMatch）。接口即契约一次到位（read 带 mode、写操作带可选
// opId/ifMatch 与 actorId/source 注入参数），避免后续返工。
//
// 模块拆分（保持单文件 ≤500 行，CLAUDE.md）：类型契约与能力上限常量在
// file-types.ts；执行后端（BackEnd / LocalBackend / RemoteBackend /
// If-Match 版本比对）与路由决策在 file-backends.ts；本文件仅保留门面。

import { createLogger } from "@fenix/logger";
import { AppError, ValidationError } from "../errors";
import { BusyError } from "../transport/file-ws-requests";
import { getOwnedEnvironment } from "./environment-core";
import { type BackEnd, resolveExecutionBackend } from "./file-backends";
import { assertSafePath as assertPathSafe, normalizeUploadRelativePath } from "./file-path-validator";
import {
  type FileAuthContext,
  type FileErrorType,
  FileServiceError,
  type FileWriteOptions,
  REMOTE_UPLOAD_LIMIT_MESSAGE,
  type ReadMode,
  type ReadResult,
  type StatResult,
  type TreeResult,
  type UploadFileInput,
  type UploadResult,
  type WriteResult,
} from "./file-types";
import type { FileEntry } from "./workspace-fs";

const logger = createLogger("agent-file-service");

// ── 路径校验（W6：实现委托 file-path-validator 纯函数，本地/远程同构）───
/** 统一前置校验（§2.4）：拒绝绝对路径 / `..` 段 / NUL 与控制字符。保持既有
 * 签名（路由层契约）：远程路径在发送 file_op 前同样经过本校验（D5），避免只
 * 依赖机器端自觉。全局 user/ 作用域强制已删除（F1），workspace 根内全部路径
 * 均合法，越界防护由真实路径检查（realpath，workspace-fs）承担。 */
export function assertSafePath(path: string): void {
  assertPathSafe(path);
}

// upload relativePath 规范化/校验（D16 逃逸修复）——实现迁至 validator，接口不变
export { normalizeUploadRelativePath };

/** upload 入参整批校验（D16 逃逸修复，W2 语义随迁）：relativePath 与 file.name
 *  （multipart filename 可伪造 `../`，同源漏洞）任一非法即整批拒绝，避免部分
 *  文件已落盘后才发现越界；file.name 无回退目标，空名也拒绝。 */
function validateUploadInputs(dir: string, files: UploadFileInput[]): void {
  if (dir) assertSafePath(dir);
  if (files.length === 0) throw new ValidationError("未提供任何文件");
  for (const file of files) {
    if (normalizeUploadRelativePath(file.relativePath) === null) {
      throw new ValidationError(
        "Invalid relativePath: must be a relative path without '..' segments or control characters",
      );
    }
    if (normalizeUploadRelativePath(file.name) === null || file.name.trim() === "") {
      throw new ValidationError(
        "Invalid file name: must be a relative path without '..' segments or control characters",
      );
    }
  }
}

// ── 错误映射（backend 细节只进日志，message 面向用户）─────────
function mapFileError(err: unknown): FileServiceError {
  if (err instanceof FileServiceError) return err;
  if (err instanceof BusyError) return new FileServiceError("文件服务繁忙，请稍后重试", "busy", 429);
  if (err instanceof AppError) {
    const byStatus: Record<number, FileErrorType> = {
      400: "validation_error",
      403: "forbidden",
      404: "not_found",
      409: "version_conflict",
      413: "payload_too_large",
      422: "config_error",
      429: "busy",
      503: "file_service_unavailable",
    };
    const type = byStatus[err.statusCode] ?? "file_service_unavailable";
    return new FileServiceError(err.message, type, err.statusCode);
  }
  logger.error("文件操作失败（未预期异常）", err instanceof Error ? err.message : String(err));
  return new FileServiceError("文件服务不可用，请稍后重试", "file_service_unavailable", 503);
}

// ── 门面（§2.1）─────────────────────────────────────────────────
/** 门面统一操作入口（envId 由 gate 注入，参数来自已认证环境上下文） */
export interface AgentFileService {
  tree(path?: string): Promise<TreeResult>;
  list(path: string): Promise<FileEntry[]>;
  read(path: string, mode: ReadMode): Promise<ReadResult>;
  write(path: string, content: string, options?: FileWriteOptions): Promise<WriteResult>;
  upload(dir: string, files: UploadFileInput[], options?: FileWriteOptions): Promise<UploadResult>;
  delete(path: string, options?: FileWriteOptions): Promise<void>;
  mkdir(path: string, options?: FileWriteOptions): Promise<void>;
  rename(oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void>;
  stat(path: string): Promise<StatResult>;
  downloadZip(path: string): Promise<NodeJS.ReadableStream>;
}

class AgentFileServiceImpl implements AgentFileService {
  constructor(
    private envId: string,
    private auth: FileAuthContext,
  ) {}
  private async run<T>(op: (backend: BackEnd) => Promise<T>, validate?: () => void): Promise<T> {
    try {
      validate?.();
      await this.ensureEnvironment();
      const backend = await resolveExecutionBackend(this.envId);
      return await op(backend);
    } catch (err) {
      throw mapFileError(err);
    }
  }
  private async ensureEnvironment(): Promise<void> {
    // W17 启用角色检查前，getOwnedEnvironment 尚无 role 参数（environment-core 为 W17 独占）；
    // 用扩展签名透传 auth.role（JS 运行时忽略多余参数），W17 启用后调用点无需改动。
    const getOwned = getOwnedEnvironment as (
      envId: string,
      organizationId: string,
      userId?: string,
      role?: string,
    ) => Promise<unknown>;
    await getOwned(this.envId, this.auth.organizationId, this.auth.userId, this.auth.role);
  }
  private writeOptions(options?: FileWriteOptions): FileWriteOptions {
    return { ...options, actorId: this.auth.actorId, source: this.auth.source };
  }
  async tree(path?: string): Promise<TreeResult> {
    const validate = () => (path ? assertSafePath(path) : undefined);
    return this.run((b) => b.tree(this.envId, path), validate);
  }
  async list(path: string): Promise<FileEntry[]> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.list(this.envId, path), validate);
  }
  async read(path: string, mode: ReadMode): Promise<ReadResult> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.read(this.envId, path, mode), validate);
  }
  async write(path: string, content: string, options?: FileWriteOptions): Promise<WriteResult> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.write(this.envId, path, content, this.writeOptions(options)), validate);
  }
  async upload(dir: string, files: UploadFileInput[], options?: FileWriteOptions): Promise<UploadResult> {
    const validate = () => validateUploadInputs(dir, files);
    return this.run((b) => {
      // W8b（P1-11b）：能力上限不对称检查（本地 100MB / 远程 20MB，§2.4 能力上限
      // 不对称条款）。任一单文件超限即整批拒绝（与路径校验同原子性，避免部分落盘）；
      // 远程 >20MB 从可上传变 413 是破坏性契约变更，message 面向用户（§7.6 能力回退声明）。
      const oversized = files.find((f) => f.content.byteLength > b.uploadMaxBytes);
      if (oversized) throw new FileServiceError(REMOTE_UPLOAD_LIMIT_MESSAGE, "payload_too_large", 413);
      return b.upload(this.envId, dir, files, this.writeOptions(options));
    }, validate);
  }
  async delete(path: string, options?: FileWriteOptions): Promise<void> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.delete(this.envId, path, this.writeOptions(options)), validate);
  }
  async mkdir(path: string, options?: FileWriteOptions): Promise<void> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.mkdir(this.envId, path, this.writeOptions(options)), validate);
  }
  async rename(oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void> {
    const validate = () => {
      assertSafePath(oldPath);
      assertSafePath(newPath);
    };
    return this.run((b) => b.rename(this.envId, oldPath, newPath, this.writeOptions(options)), validate);
  }
  async stat(path: string): Promise<StatResult> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.stat(this.envId, path), validate);
  }
  async downloadZip(path: string): Promise<NodeJS.ReadableStream> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.downloadZip(this.envId, path), validate);
  }
}

/** 门面入口：envId + 认证上下文（orgId/userId 归属校验，role 透传待 W17 启用） */
export function gate(envId: string, authCtx: FileAuthContext): AgentFileService {
  return new AgentFileServiceImpl(envId, authCtx);
}
