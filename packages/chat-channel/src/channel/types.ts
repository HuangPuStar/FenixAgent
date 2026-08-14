// packages/chat-channel/src/channel/types.ts
// Action / Ack 协议类型（文档 7.1 修订，PRD Q5/Q9）。
//
// 前端最小配合：只新增 commandId（UUID）；protocolVersion / expectedProjectionVersion /
// client 信封字段在类型中保留定义，由服务端按会话绑定补充与校验（乐观并发增强留二期）。

/** 控制面已知 Action 类型（与 translateSimpleAction 的 action 一一对应） */
export const KNOWN_ACTION_TYPES = [
  "send_prompt",
  "cancel",
  "create_session",
  "load_session",
  "resume_session",
  "list_sessions",
  "rename_session",
  "delete_session",
  "respond_permission",
  "set_session_mode",
] as const;

export const ACTION_ACK_STATUSES = ["accepted", "committed", "duplicate"] as const;
export type ActionAckStatus = (typeof ACTION_ACK_STATUSES)[number];

/** 两阶段 Ack：accepted（进入有界队列）→ committed（业务事实已提交） */
export interface ActionAck {
  type: "action_ack";
  commandId: string;
  status: ActionAckStatus;
  turnId?: string;
  committedProjectionVersion?: number;
}

export const ACTION_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "SESSION_NOT_FOUND",
  "VERSION_CONFLICT",
  "INVALID_STATE",
  "RATE_LIMITED",
  "AGENT_UNAVAILABLE",
  "PAYLOAD_TOO_LARGE",
] as const;

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

/** Action 失败响应：稳定错误码 + retryable 标记，不泄露内部实现细节 */
export interface ActionError {
  type: "action_error";
  commandId: string;
  code: ActionErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** 归一化后的服务端命令（SessionChannel 产出，CommandCoordinator 消费） */
export interface Command {
  rcsSessionId: string;
  commandId: string;
  type: string;
  /** 会话标识（服务端按会话绑定补充，浏览器字段不可覆盖 binding） */
  sessionId: string;
  /** 业务字段（不含 action/commandId 等信封字段） */
  payload: Record<string, unknown>;
  expectedProjectionVersion?: number;
}

/** 命令执行结果：committed Ack 的补充信息 */
export interface CommandOutcome {
  turnId?: string;
}

/** Ack / Error 发送目标（通常为发起 Action 的连接） */
export interface ActionSinks {
  sendAck: (ack: ActionAck) => void;
  sendError: (error: ActionError) => void;
}

/**
 * 命令执行失败：携带稳定错误码与重试语义。
 * 只允许在业务校验与执行边界抛出，message 必须可安全展示给客户端。
 */
export class CommandExecutionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CommandExecutionError";
  }
}

/** 单条命令的最大 payload 大小（JSON 序列化后），超过返回 PAYLOAD_TOO_LARGE */
export const MAX_ACTION_PAYLOAD_BYTES = 1024 * 1024;
