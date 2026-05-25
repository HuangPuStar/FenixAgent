/**
 * Core 层可调度 node 的稳定模型。
 */

/**
 * 当前 core 仅支持本地 node。
 */
export type CoreNodeMode = "local";

/**
 * Core 层关心的 node 在线状态。
 */
export type CoreNodeStatus = "online" | "offline";

/**
 * Core 侧保存的 node 记录。
 */
export interface CoreNode {
  /** Core 内部使用的 node 唯一标识。 */
  id: string;
  /** 当前 node 的部署模式；本轮仅支持本地模式。 */
  mode: CoreNodeMode;
  /** 该 node 声明支持调度的 engine 类型列表。 */
  engineTypes: string[];
  /** 编排层看到的在线状态。 */
  status: CoreNodeStatus;
  /** 预留给宿主侧扩展的附加元数据。 */
  metadata?: Record<string, unknown>;
}

/**
 * 注册 node 时使用的只读输入结构。
 */
export interface CreateCoreNodeInput {
  /** 待注册 node 的唯一标识。 */
  id: string;
  /** 待注册 node 的部署模式。 */
  mode: CoreNodeMode;
  /** 待注册 node 支持的 engine 类型列表。 */
  engineTypes: string[];
  /** 待注册 node 的初始在线状态。 */
  status: CoreNodeStatus;
  /** 待注册 node 关联的附加元数据。 */
  metadata?: Record<string, unknown>;
}
