// file-types.ts — AgentFileService 的类型契约与能力上限（W5a，P1-7a 拆分）
//
// 自 agent-file-service.ts 拆出的契约层（保持门面单文件 ≤500 行，CLAUDE.md，
// 与 transport 侧拆出 file-machine-events / file-op-retry / file-ws-requests 的
// 先例一致）。职责边界：
// - 能力上限常量（§2.4 能力上限不对称条款）：本地 100MB / 远程 20MB，
//   W8b 起在 upload 入口强制检查；
// - 门面契约类型：FileAuthContext / FileWriteOptions / ReadResult / StatResult /
//   TreeResult / WriteResult / UploadFileInput / UploadResult / FileErrorType；
// - FileServiceError：门面统一抛出的错误，路由层（W5b）按 type 映射 HTTP 响应。
//
// 本模块为纯类型/常量层（不 import 任何运行时模块），供门面（agent-file-service）、
// 执行后端（file-backends.ts）与路由层共同引用，避免互相导入成环。

// ── 能力上限常量（§2.4 能力上限不对称条款，W8b 起在 upload 入口强制检查）──
export const LOCAL_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const REMOTE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** upload 超限的 413 用户可读文案（跨 plan 契约固定，测试断言锁定；remote-file-service.ts
 *  的防线重复声明同文案——两模块互相导入会成环，改文案必须两处同步）。 */
export const REMOTE_UPLOAD_LIMIT_MESSAGE =
  "单文件上限 20MB（远程环境）；更大文件可通过本地环境上传或让 Agent 用工具拉取";

// ── 类型定义（契约）──────────────────────────────────────────────
/** 写操作审计注入上下文（P2-18 契约字段；role 供 W17 启用检查，当前透传不校验） */
export interface FileAuthContext {
  organizationId: string;
  userId: string;
  role?: string;
  /** 写操作审计身份：userId 或 instanceId */
  actorId: string;
  source: "user" | "agent" | "api";
}
/** 写操作可选参数（契约占位，P2 落地）：opId 幂等键 / ifMatch 条件写 / 审计字段 */
export interface FileWriteOptions {
  opId?: string;
  ifMatch?: string;
  actorId?: string;
  source?: "user" | "agent" | "api";
}
export type ReadMode = "text" | "binary" | "auto";
/** mtimeMs：ETag 派生用（§4.2 read 指纹）；远程数据源无 mtime → 缺省（路由层退化为 size-only 弱指纹） */
export type ReadResult =
  | {
      type: "text";
      name: string;
      path: string;
      content: string;
      size: number;
      encoding: string;
      mtimeMs?: number;
    }
  | {
      type: "binary";
      name: string;
      path: string;
      size: number;
      mimeType: string;
      stream: NodeJS.ReadableStream;
      mtimeMs?: number;
    };
export interface TreeResult {
  paths: string[];
  mtimes?: Record<string, number>;
  errors?: { path: string; message: string }[];
}
export interface StatResult {
  size: number;
  isDirectory: boolean;
  modifiedAt: number;
  /** 是否文本文件（本地探测；供预览决策），远程暂无该信息 */
  isText?: boolean;
}
export interface WriteResult {
  name: string;
  path: string;
  size: number;
}
export interface UploadFileInput {
  name: string;
  content: Uint8Array;
  relativePath?: string;
}
export interface UploadResult {
  files: Array<{ name: string; path: string; size: number }>;
}
/** 统一错误码（§2.4）；version_conflict 为 W12b 预留 */
export type FileErrorType =
  | "validation_error"
  | "forbidden"
  | "not_found"
  | "payload_too_large"
  | "config_error"
  | "busy"
  | "file_service_unavailable"
  | "version_conflict";

/** 门面统一抛出的错误：路由层（W5b）按 type 映射 HTTP 响应，message 面向用户 */
export class FileServiceError extends Error {
  constructor(
    message: string,
    public readonly type: FileErrorType,
    public readonly statusCode: number,
    /** 409 version_conflict 时携带的当前版本（§4.4 覆盖可感知性，响应回显给消费者）；
     *  其他错误类型为 undefined */
    public readonly currentVersion?: { etag: string; mtimeMs: number; size: number },
  ) {
    super(message);
    this.name = "FileServiceError";
  }
}
