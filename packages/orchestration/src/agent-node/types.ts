/**
 * AgentNode 子域的公开类型。
 *
 * 定义 AgentNode 持有的 WS 信道抽象（不绑定任何具体 ws 库，宿主注入实现）、
 * AgentNode 构造选项与 AgentNodeService 配置；状态枚举 {@link AgentNodeStatus}
 * 复用 `types/domain.ts` 的领域定义，此处仅 re-export。
 */

import type { AgentNodeStatus } from "../types/domain";
import type { AgentNode } from "./agent-node";

export type { AgentNodeStatus };

/** 默认连接建立超时：10s。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** 默认自动重连间隔：1s。 */
export const DEFAULT_RECONNECT_DELAY_MS = 1_000;

/** 定时器抽象：允许测试注入手动调度器，避免依赖真实时钟。 */
export interface TimerScheduler {
  /** 调度一个延迟任务，返回可传给 {@link clearTimeout} 的句柄。 */
  setTimeout(handler: () => void, ms: number): unknown;
  /** 取消一个已调度的任务（幂等）。 */
  clearTimeout(handle: unknown): void;
}

/** 默认定时器实现：直接委托全局 setTimeout / clearTimeout。 */
export const DEFAULT_SCHEDULER: TimerScheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  // 收窄为 NodeJS.Timeout 便于类型对齐；handle 由 clearTimeout 原样消费，仅类型层面转换
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * AgentNode 持有的 WS 信道抽象。
 *
 * 只声明 AgentNode 需要的最小能力，不依赖具体 ws 库；每个事件仅保留一个 handler，
 * 重复注册覆盖前一个（AgentNode 重绑定时依赖此语义）。`close()` 的实现必须保证
 * 最终触发 onClose 回调，AgentNode 依赖该回调完成 closing → closed 的确认。
 */
export interface AgentNodeSocket {
  /** 发送数据帧；仅在 connected 状态下被 AgentNode 调用。 */
  send(data: unknown): void;
  /** 主动关闭底层连接；实现必须保证最终触发 onClose。 */
  close(): void;
  /** 注册连接建立回调（覆盖式）。 */
  onOpen(handler: () => void): void;
  /** 注册连接关闭回调（覆盖式）。 */
  onClose(handler: () => void): void;
  /** 注册错误回调（覆盖式）；错误按连接失败/断连处理。 */
  onError(handler: () => void): void;
}

/** AgentNode 构造选项。 */
export interface AgentNodeOptions {
  /** 远端机器标识。 */
  machineId: string;
  /** 初始 WS 信道。 */
  socket: AgentNodeSocket;
  /** 连接建立超时（ms），默认 {@link DEFAULT_CONNECT_TIMEOUT_MS}。 */
  connectTimeoutMs?: number;
  /** 意外断连后的自动重连最大次数，默认 0（不重连）。 */
  maxRetries?: number;
  /** 自动重连间隔（ms），默认 {@link DEFAULT_RECONNECT_DELAY_MS}。 */
  reconnectDelayMs?: number;
  /** 定时器抽象，默认使用全局 setTimeout/clearTimeout。 */
  scheduler?: TimerScheduler;
  /** 状态变化回调（含状态变化前后的值），供 AgentNodeService 做资源回收。 */
  onStatusChange?: (status: AgentNodeStatus, previous: AgentNodeStatus) => void;
  /**
   * 自动重连停止回调：重试耗尽（保持 disconnected）或重连失败（回退 uninitialized）
   * 时触发，节点此后不再自动恢复；宿主可据此回收无实例引用的节点。
   */
  onAutoReconnectStopped?: () => void;
}

/** AgentNodeService 配置。 */
export interface AgentNodeServiceConfig {
  /** 引用计数归零后等待多久触发节点关闭回收（ms）。 */
  idleTimeoutMs: number;
  /** 每个 AgentNode 的自动重连最大次数（创建节点时透传给 AgentNode）。 */
  maxRetries: number;
  /** 自动重连间隔（ms），默认 {@link DEFAULT_RECONNECT_DELAY_MS}。 */
  reconnectDelayMs?: number;
  /** 连接建立超时（ms），默认 {@link DEFAULT_CONNECT_TIMEOUT_MS}。 */
  connectTimeoutMs?: number;
  /** 定时器抽象，默认使用全局 setTimeout/clearTimeout。 */
  scheduler?: TimerScheduler;
}

/**
 * AgentNodeService 的最小依赖面（供 AgentController 等上层消费）。
 *
 * 只声明上层需要的两个操作，`AgentNodeService` 与测试 mock 均可满足该结构，
 * 避免上层耦合具体类的私有实现细节。
 */
export interface AgentNodeServicePort {
  /**
   * 获取 AgentNode（引用计数 +1）；节点不存在或未处于 connected 状态
   * （未连接 / 断连 / 重连中 / 关闭中）时抛 AgentNodeUnavailableError。
   */
  ensureNode(machineId: string): AgentNode;
  /** 归还节点引用（计数 -1）；节点未被管理时抛 AgentNodeUnavailableError。 */
  releaseNode(machineId: string): void;
}
