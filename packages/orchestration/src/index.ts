/**
 * `@fenix/orchestration` 的公开导出面。
 *
 * 编排域独立包的对外入口，统一导出：
 *   - 数据访问契约（types/deps.ts 的 4 个 Repo 接口及其数据形状）
 *   - 公开领域类型（types/domain.ts）
 *   - 分层异常体系（errors.ts）
 *   - AgentNode 生命周期能力（agent-node/：AgentNode、AgentNodeService 及配置类型）
 *   - Instance 运行时载体（instance/：Instance）
 *   - LaunchSpec 构建能力（launch-spec/：LaunchSpecBuilder 及 LaunchSpec）
 *   - 编排域统一入口（agent-controller/：AgentController）
 */

export type { AgentControllerDeps } from "./agent-controller";
// AgentController 编排入口
export { AgentController } from "./agent-controller";
// AgentNode 生命周期
export { AgentNode } from "./agent-node/agent-node";
export { AgentNodeService } from "./agent-node/agent-node-service";
export type {
  AgentNodeOptions,
  AgentNodeServiceConfig,
  AgentNodeServicePort,
  AgentNodeSocket,
  TimerScheduler,
} from "./agent-node/types";
// 分层异常
export {
  AgentNodeConnectionConflictError,
  AgentNodeUnavailableError,
  EnvironmentNotFoundError,
  IllegalStateTransitionError,
  LaunchSpecBuildError,
  MachineOfflineError,
  OrchestrationError,
} from "./errors";
export type { InstanceParams } from "./instance/instance";
// Instance 运行时载体
export { Instance } from "./instance/instance";
export type { InstanceInfo, InstanceStatus } from "./instance/types";
export type { LaunchSpecBuilderDeps } from "./launch-spec/launch-spec-builder";
// LaunchSpec 构建
export { LaunchSpecBuilder } from "./launch-spec/launch-spec-builder";
export type { LaunchSpec } from "./launch-spec/types";
// 数据访问契约
export type {
  AgentConfigData,
  AgentConfigRepo,
  AgentEngineData,
  AgentEngineRepo,
  AgentMachineData,
  AgentMachineRepo,
  EnvironmentData,
  EnvironmentRepo,
} from "./types/deps";
// 公开领域类型
export type { AgentNodeStatus, SpawnRequest, SpawnResult } from "./types/domain";
