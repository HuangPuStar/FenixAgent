/**
 * `@mothership/core` 的受控公开导出面。
 */
export { createCoreRuntime } from "./facade/core-runtime";
export type {
  CoreRuntimeFacade,
  CreateCoreRuntimeOptions,
} from "./facade/core-runtime";

export { EnginePluginRegistry } from "./registry/engine-plugin-registry";
export { CoreNodeRegistry } from "./registry/core-node-registry";

export type {
  CoreNode,
  CoreNodeMode,
  CoreNodeStatus,
  CreateCoreNodeInput,
} from "./types/core-node";
export type {
  LaunchInstanceRequest,
  ConnectInstanceRelayRequest,
  StopInstanceRequest,
} from "./types/launch-request";
export type {
  RuntimeInstanceRecord,
  RuntimeInstanceSnapshot,
  RuntimeInstanceStatus,
} from "./types/runtime-instance";

export {
  CoreRuntimeError,
  isCoreRuntimeError,
  createCoreRuntimeError,
} from "./errors/core-runtime-error";
export type { CoreRuntimeErrorCode } from "./errors/core-runtime-error";

export { createRuntimeInstanceStore } from "./runtime/runtime-instance-store";
export type { RuntimeInstanceStore } from "./runtime/runtime-instance-store";
