import type { AgentLaunchSpec } from "@mothership/plugin-sdk";

/**
 * Core 编排层维护的实例状态枚举。
 */
export type RuntimeInstanceStatus =
  | "created"
  | "preparing"
  | "prepared"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

/**
 * Core 编排层持久化的实例记录。
 */
export interface RuntimeInstanceRecord {
  /** Core 侧生成的实例唯一标识。 */
  instanceId: string;
  /** 实例当前使用的 engine 类型。 */
  engineType: string;
  /** 实例被调度到的 node 标识。 */
  nodeId: string;
  /** Core 编排层维护的生命周期状态。 */
  status: RuntimeInstanceStatus;
  /** 创建该实例时使用的完整启动配置。 */
  launchSpec: AgentLaunchSpec;
  /** Core 是否认为当前已建立 relay 连接。 */
  relayConnected: boolean;
  /** 最近一次失败时记录的错误信息。 */
  errorMessage?: string;
  /** 实例记录首次创建时间。 */
  createdAt: Date;
  /** 实例记录最近一次更新时间。 */
  updatedAt: Date;
}

/**
 * 对外暴露的实例只读快照。
 */
export type RuntimeInstanceSnapshot = Readonly<RuntimeInstanceRecord>;
