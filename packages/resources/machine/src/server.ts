/**
 * Machine 资源包服务端公开入口。
 *
 * 依赖方向：宿主 `apps/server`、`@fenix/agent-runtime` 与 `@fenix/resource-sandbox` 是合法消费者；路由一律
 * 以工厂形式导出，认证守卫由宿主注入（理由见 `./server/routes/dependencies`）。本入口不导出浏览器代码，也不
 * 导出测试替身（替身在 `./server/testing`）。
 */

export * from "./schemas/api-workspace.schema";
export * from "./schemas/file.schema";
export * from "./schemas/file-events.schema";
export * from "./schemas/registry.schema";
export type { MachineModuleConfig } from "./server/config";
export { getMachineConfig } from "./server/config";
export { getMachineDatabase, type MachineDatabase } from "./server/db";
export * from "./server/repositories/agent-machine";
export * from "./server/repositories/machine-repository";
export { createApiWorkspaceRoutes } from "./server/routes/api/workspaces";
export type {
  MachineRequestAuthResult,
  WebFileEventsRouteDependencies,
  WebMachineRouteDependencies,
} from "./server/routes/dependencies";
export { createWebFileEventsRoutes } from "./server/routes/web/file-events";
export { contentDispositionAttachment, createWebFsRoutes } from "./server/routes/web/fs";
export { createWebRegistryRoutes } from "./server/routes/web/registry";
export * from "./server/services/agent-file-service";
export * from "./server/services/api-workspace";
export * from "./server/services/file-backends";
export type { FileChangeEvent } from "./server/services/file-event-limiter";
export {
  flushPendingBatches,
  publishDegradedLimited,
  publishFileChanged,
  publishInvalidateAllLimited,
} from "./server/services/file-event-limiter";
export type { FileEventInput, FileEventSubscriber } from "./server/services/file-event-queue";
export {
  destroyEnvironmentQueue,
  ensure,
  publishFileEvent,
  publishInvalidateAll,
  registerEnvironmentQueue,
  subscribe,
} from "./server/services/file-event-queue";
export * from "./server/services/file-machine-events";
export {
  getFileNameByteLength,
  hasPathControlCharacter,
  MAX_FILE_NAME_BYTES,
} from "./server/services/file-path-validator";
export * from "./server/services/file-types";
export * from "./server/services/machine-connection-waiter";
export * from "./server/services/machine-runtime";
export * from "./server/services/machine-sandbox-projection";
export * from "./server/services/registry";
export * from "./server/services/registry-heartbeat";
export * from "./server/services/remote-file-service";
export type { ResolvedWorkspacePath, TreeNodeEntry } from "./server/services/workspace-fs";
export {
  computeListFingerprint,
  computeReadFingerprint,
  computeTreeFingerprint,
  createFileStream,
  deleteFile,
  deleteNode,
  getMimeType,
  isTextExtension,
  isTextFile,
  isUserPath,
  listDirectory,
  listPathsRecursive,
  mkdirp,
  normalizeUserRoutePath,
  readFileContent,
  renamePath,
  resolveWorkspacePath,
  shouldHideEntry,
  shouldHidePath,
  writeFileContent,
} from "./server/services/workspace-fs";
export * from "./server/transport/file-op-retry";
export * from "./server/transport/file-ws-close-log";
export * from "./server/transport/file-ws-handler";
export * from "./server/transport/file-ws-payload";
export * from "./server/transport/file-ws-requests";
export * from "./services/event-service";
export * from "./services/local-node-service";
