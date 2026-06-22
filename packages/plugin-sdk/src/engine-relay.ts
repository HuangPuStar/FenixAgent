/**
 * Engine 与宿主之间实时 relay 协议使用的最小类型集合。
 */
/**
 * Engine relay 通道上传输的通用消息结构。
 */
export interface EngineRelayMessage {
  type: string;
  payload?: unknown;
}

export type EngineRelayState = "open" | "closed";

/**
 * Engine 暴露给 Core 的实时 relay 句柄。
 */
export interface EngineRelayHandle {
  /** 当前 relay 连接状态。 */
  readonly state: EngineRelayState;
  /** 向 engine 发送一条实时消息。 */
  send(message: EngineRelayMessage): Promise<void> | void;
  /** 主动关闭 relay 连接。 */
  close(code?: number, reason?: string): Promise<void> | void;
  /** 监听 engine 侧推送的实时消息。返回 unsub 函数。 */
  onMessage?(listener: (message: EngineRelayMessage) => void): () => void;
  /** relay 连接就绪后的 resolve Promise（WS open / bridge 模块初始化完成）。 */
  ready?: Promise<void>;
}

/**
 * Engine 原生会话列表中的摘要信息。
 */
export interface EngineSessionSummary {
  id: string;
  title?: string;
  cwd?: string;
  updatedAt?: Date;
}

/**
 * Engine 健康检查结果。
 */
export interface EngineHealthStatus {
  ok: boolean;
  detail?: string;
}
