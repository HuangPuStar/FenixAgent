/**
 * `@fenix/orchestration` 的公开导出面。
 *
 * 编排域独立包的对外入口，统一导出：
 *   - 数据访问契约（types/deps.ts 的 Repo 接口及其数据形状）
 *   - 公开领域类型（types/domain.ts）
 *   - 分层异常体系（errors.ts）
 *   - AgentNode 生命周期能力（agent-node/：AgentNode、AgentNodeService 及配置类型）
 *   - Instance 运行时载体（instance/：Instance）
 *   - 编排域统一入口（agent-controller/：AgentController）
 *
 * 不导出 LaunchSpec 构建能力：启动参数（模型密钥、Skill、MCP、知识库）的组装属资源领域，
 * 由 `@fenix/agent-config` 承担（CE 1.4 W4 收敛）。
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
// 数据访问契约
export type {
  AgentMachineData,
  AgentMachineRepo,
  EnvironmentData,
  EnvironmentRepo,
} from "./types/deps";
// 公开领域类型
export type { AgentNodeStatus, SpawnRequest, SpawnResult } from "./types/domain";
