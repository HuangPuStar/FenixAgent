/**
 * CloudDrive 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server` 是唯一合法消费者（按 manifest 的 `app-route` 贡献挂载）；本入口不导出
 * 浏览器代码——前端 owner 落地时再补 `@fenix/resource-cloud-drive/web`。
 *
 * 导出面刻意包含协议模型与 client 错误类型：前端 API 模块需要 DTO 类型，测试需要构造 HTTP 替身；
 * 但 Facade 与 client 都不接受「调用方指定 subject」的参数，subject 只能来自路由的会话上下文。
 */

export type {
  CloudDriveClientConfig,
  CloudDriveClientOptions,
  CloudDriveDiagnostic,
  CloudDriveDiagnosticHandler,
} from "./server/client/cloud-drive-client";
export { CloudDriveClient, resolveCloudDriveClientConfig } from "./server/client/cloud-drive-client";
export { CloudDriveError, type CloudDriveFailureKind } from "./server/client/cloud-drive-error";
export type {
  BeginUploadInput,
  CloudDriveGateway,
  ContentInput,
  CreateDirectoryInput,
  DeleteFileInput,
  ListFilesInput,
  MarkdownInput,
  MoveFileInput,
  PatchUploadInput,
  PreviewPageInput,
  RequestConversionInput,
  RestoreTrashInput,
  SearchInput,
} from "./server/client/cloud-drive-gateway";
export type { CloudDriveModuleConfig } from "./server/config";
export { getCloudDriveConfig } from "./server/config";
export type {
  BeginUploadCommand,
  CloudDriveActor,
  CloudDriveContent,
  CloudDriveFacade,
  CloudDriveFacadeOptions,
  ContentCommand,
  CreateDirectoryCommand,
  ListFilesCommand,
  MoveFileCommand,
  RestoreTrashCommand,
  SearchCommand,
  UploadChunkCommand,
} from "./server/facades/cloud-drive-facade";
export { createCloudDriveFacade } from "./server/facades/cloud-drive-facade";
export type {
  CloudDrivePreviewPageContent,
  MarkdownCommand,
  PreviewPageCommand,
} from "./server/facades/cloud-drive-preview";
export type { CloudDriveFailure, CloudDriveResult } from "./server/facades/cloud-drive-result";
export type { CloudDriveMcpScope, CloudDriveMcpTokenClaims } from "./server/mcp/token";
export {
  CloudDriveMcpTokenError,
  issueCloudDriveMcpToken,
  verifyCloudDriveMcpToken,
} from "./server/mcp/token";
export type {
  CloudDriveMcpErrorCode,
  CloudDriveMcpTool,
  CloudDriveMcpToolContext,
  CloudDriveMcpToolOutcome,
  CloudDriveMcpToolResult,
} from "./server/mcp/tool-support";
export { listCloudDriveToolNames, selectCloudDriveTools } from "./server/mcp/tools";
export type { CloudDriveRouteDependencies, SessionAuthContext } from "./server/routes/dependencies";
export type { CloudDriveMcpRouteDependencies } from "./server/routes/mcp/cloud-drive";
export { createCloudDriveMcpRoutes } from "./server/routes/mcp/cloud-drive";
export { createWebCloudDriveRoutes } from "./server/routes/web/cloud-drive";
export * from "./server/schemas/cloud-drive.schema";
