/**
 * 编排域的公开领域类型。
 *
 * 集中定义 AgentNode 生命周期、运行实例（Instance）以及启动请求/结果的领域模型，
 * 供编排域内部模块与外部调用方共用。
 */

/** 实例对外可见的运行状态。 */
export type InstanceStatus = "starting" | "running" | "stopped" | "error";

/**
 * AgentNode 生命周期状态。
 *
 * 状态转换由 AgentNode FSM 维护（见 I2）：uninitialized → connecting → connected，
 * 意外断连进入 disconnected 并自动重连；主动关闭走 closing → closed；destroyed 为终态。
 */
export type AgentNodeStatus =
  | "uninitialized"
  | "connecting"
  | "connected"
  | "disconnected"
  | "closing"
  | "closed"
  | "destroyed";

/** 运行实例的不可变快照信息，用于对外查询与展示。 */
export interface InstanceInfo {
  instanceId: string;
  environmentId: string;
  agentConfigId: string;
  machineId: string;
  status: InstanceStatus;
}

/** 启动 Agent 实例的请求参数。 */
export interface SpawnRequest {
  /** 目标环境 ID。 */
  environmentId: string;
  /** 发起启动的用户 ID。 */
  userId: string;
}

/** 启动 Agent 实例的结果。 */
export interface SpawnResult {
  /** 启动成功后的实例信息。 */
  instance: InstanceInfo;
}
