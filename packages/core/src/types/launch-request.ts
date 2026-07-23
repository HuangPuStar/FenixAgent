import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

/**
 * 启动一个 runtime instance 所需的最小请求。
 */
export interface LaunchInstanceRequest {
  /** 目标实例 ID。 */
  instanceId: string;
  /** 需要调用的 engine 类型。local 执行时由上层传入，remote 时不传。 */
  engineType?: string;
  /** 需要调度到的 node ID。 */
  nodeId: string;
  /** 传入 engine prepare 阶段的启动配置。 */
  launchSpec: AgentLaunchSpec;
}

/**
 * 为已启动实例建立 relay 的请求。
 */
export interface ConnectInstanceRelayRequest {
  /** 要连接 relay 的实例 ID。 */
  instanceId: string;
  /** 可选的会话 ID，用于 relay 恢复或路由。 */
  sessionId?: string;
}

/**
 * 停止实例的最小请求。
 */
export interface StopInstanceRequest {
  /** 需要停止的实例 ID。 */
  instanceId: string;
}
