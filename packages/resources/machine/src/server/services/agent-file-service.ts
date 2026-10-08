// AgentFileService —— 统一文件执行面（W5a，P1-7a）
// 文件域的领域执行面：路由决策（machineId 回退链）→ 统一路径校验 → BackEnd 执行
// → 统一错误映射。fs.ts 双分支（W5b）收敛后 `/web` 文件路由只经
// `../facades/machine-file-facade` 进入本层；后续波次小改（W6 校验接 validator /
// W7 事件发布 / W12b 启用 opId/ifMatch）。接口即契约一次到位（read 带 mode、写操作
// 带可选 opId/ifMatch 与 actorId/source 注入参数），避免后续返工。
//
// 认证/授权不在这里：环境归属与角色（`member` → 403，fail-closed）由 Facade 在打开执行面
// 之前判定（§3.2「授权止于 Facade」），本层只接受已授权的显式范围（AgentFileScope）。
//
// 模块拆分（保持单文件 ≤500 行，CLAUDE.md）：类型契约与能力上限常量在
// file-types.ts；执行后端（BackEnd / LocalBackend / RemoteBackend /
// If-Match 版本比对）与路由决策在 file-backends.ts；本文件仅保留执行面。

import { createLogger } from "@fenix/logger";
import { AppError, ValidationError } from "@fenix/platform-sdk";
import { BusyError } from "../transport/file-ws-requests";
import { type BackEnd, resolveExecutionBackend } from "./file-backends";
import { assertSafePath as assertPathSafe, normalizeUploadRelativePath } from "./file-path-validator";
import {
  type AgentFileScope,
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
/**
 * 把执行期异常收敛成文件域错误信封（§2.4 错误码表）。
 *
 * 导出给 Facade 复用：环境归属失败发生在门面里（授权止于门面，§3.2），但对外必须与执行期失败同一套
 * 分类与文案，否则同一个「环境不可见」会在 403/404 与 503 之间漂移。
 */
export function mapFileError(err: unknown): FileServiceError {
  if (err instanceof FileServiceError) return err;
  if (err instanceof Error && "code" in err && (err.code === "EEXIST" || err.code === "ENOTEMPTY")) {
    return new FileServiceError("目标文件或目录已存在，未覆盖原内容，请修改名称后重试", "path_conflict", 409);
  }
  if (err instanceof BusyError) return new FileServiceError("文件服务繁忙，请稍后重试", "busy", 429);
  if (err instanceof AppError) {
    if (err.statusCode === 409 && err.code === "path_conflict") {
      return new FileServiceError("目标文件或目录已存在，未覆盖原内容，请修改名称后重试", "path_conflict", 409);
    }
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

// ── 领域执行面（§2.1）────────────────────────────────────────────
/**
 * 文件域执行面：一个已授权环境上的本地/远程文件操作。
 *
 * 实例由 {@link createAgentFileService} 以**显式范围**构造，不接受 actor、不做用户权限判断——环境归属与
 * 角色的授权在 `../facades/machine-file-facade` 完成（§3.2）。因此本接口的每个方法都假定「调用方已确认
 * 该环境属于当前主体」。
 */
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
  constructor(private scope: AgentFileScope) {}
  private async run<T>(op: (backend: BackEnd) => Promise<T>, validate?: () => void): Promise<T> {
    try {
      validate?.();
      const backend = await resolveExecutionBackend(this.scope.environmentId);
      return await op(backend);
    } catch (err) {
      throw mapFileError(err);
    }
  }
  private writeOptions(options?: FileWriteOptions): FileWriteOptions {
    return { ...options, actorId: this.scope.actorId, source: this.scope.source };
  }
  async tree(path?: string): Promise<TreeResult> {
    const validate = () => (path ? assertSafePath(path) : undefined);
    return this.run((b) => b.tree(this.scope.environmentId, path), validate);
  }
  async list(path: string): Promise<FileEntry[]> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.list(this.scope.environmentId, path), validate);
  }
  async read(path: string, mode: ReadMode): Promise<ReadResult> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.read(this.scope.environmentId, path, mode), validate);
  }
  async write(path: string, content: string, options?: FileWriteOptions): Promise<WriteResult> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.write(this.scope.environmentId, path, content, this.writeOptions(options)), validate);
  }
  async upload(dir: string, files: UploadFileInput[], options?: FileWriteOptions): Promise<UploadResult> {
    const validate = () => validateUploadInputs(dir, files);
    return this.run((b) => {
      // W8b（P1-11b）：能力上限不对称检查（本地 100MB / 远程 20MB，§2.4 能力上限
      // 不对称条款）。任一单文件超限即整批拒绝（与路径校验同原子性，避免部分落盘）；
      // 远程 >20MB 从可上传变 413 是破坏性契约变更，message 面向用户（§7.6 能力回退声明）。
      const oversized = files.find((f) => f.content.byteLength > b.uploadMaxBytes);
      if (oversized) throw new FileServiceError(REMOTE_UPLOAD_LIMIT_MESSAGE, "payload_too_large", 413);
      return b.upload(this.scope.environmentId, dir, files, this.writeOptions(options));
    }, validate);
  }
  async delete(path: string, options?: FileWriteOptions): Promise<void> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.delete(this.scope.environmentId, path, this.writeOptions(options)), validate);
  }
  async mkdir(path: string, options?: FileWriteOptions): Promise<void> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.mkdir(this.scope.environmentId, path, this.writeOptions(options)), validate);
  }
  async rename(oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void> {
    const validate = () => {
      assertSafePath(oldPath);
      assertSafePath(newPath);
    };
    return this.run((b) => b.rename(this.scope.environmentId, oldPath, newPath, this.writeOptions(options)), validate);
  }
  async stat(path: string): Promise<StatResult> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.stat(this.scope.environmentId, path), validate);
  }
  async downloadZip(path: string): Promise<NodeJS.ReadableStream> {
    const validate = () => assertSafePath(path);
    return this.run((b) => b.downloadZip(this.scope.environmentId, path), validate);
  }
}

/**
 * 构造某环境的文件执行面。
 *
 * 只接受显式范围（环境 + 写操作审计身份），环境归属与角色授权由 Facade 前置完成——迁移前这里还接收
 * 组织/用户/角色并在每次操作内调用 `getOwnedEnvironment`，那是把应用层授权放在领域执行面里（§3.2）。
 */
export function createAgentFileService(scope: AgentFileScope): AgentFileService {
  return new AgentFileServiceImpl(scope);
}
