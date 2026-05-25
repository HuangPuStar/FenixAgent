/**
 * `@mothership/core` 的受控公开导出面。
 */

export type { CoreRuntimeErrorCode } from "./errors/core-runtime-error";
export {
  CoreRuntimeError,
  createCoreRuntimeError,
  isCoreRuntimeError,
} from "./errors/core-runtime-error";
export type {
  CoreRuntimeFacade,
  CreateCoreRuntimeOptions,
} from "./facade/core-runtime";
export { createCoreRuntime } from "./facade/core-runtime";
export { CoreNodeRegistry } from "./registry/core-node-registry";
export { EnginePluginRegistry } from "./registry/engine-plugin-registry";
export type { RuntimeInstanceStore } from "./runtime/runtime-instance-store";
export { createRuntimeInstanceStore } from "./runtime/runtime-instance-store";
export type {
  CoreNode,
  CoreNodeMode,
  CoreNodeStatus,
  CreateCoreNodeInput,
} from "./types/core-node";
export type {
  ConnectInstanceRelayRequest,
  LaunchInstanceRequest,
  StopInstanceRequest,
} from "./types/launch-request";
export type {
  RuntimeInstanceRecord,
  RuntimeInstanceSnapshot,
  RuntimeInstanceStatus,
} from "./types/runtime-instance";
