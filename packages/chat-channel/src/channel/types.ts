// packages/chat-channel/src/channel/types.ts
// Action / Ack 协议类型（文档 7.1 修订，PRD Q5/Q9）。
//
// 前端最小配合：只新增 commandId（UUID）；protocolVersion / expectedProjectionVersion /
// client 信封字段在类型中保留定义，由服务端按会话绑定补充与校验（乐观并发增强留二期）。

import type { PublicError, PublicErrorType } from "../public-error";

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
  "respond_question",
  "set_session_mode",
  // Peri 待发送队列（steer）：能力 `peri.userInputQueue` 协商后才可用，出站方法为
  // session/input/{enqueue,dispatch,takeback}（见 protocol/translator.ts）
  "enqueue_user_input",
  "dispatch_user_inputs",
  "takeback_user_input",
] as const;

/** Peri 待发送队列（steer）三类 Action 名 */
export type UserInputQueueActionType = "enqueue_user_input" | "dispatch_user_inputs" | "takeback_user_input";

/** steer Action 清单（唯一权威：SessionChannel 的前置校验与 translator 的出站分支共用，不得各写一份） */
export const USER_INPUT_QUEUE_ACTION_TYPES: ReadonlySet<string> = new Set<UserInputQueueActionType>([
  "enqueue_user_input",
  "dispatch_user_inputs",
  "takeback_user_input",
]);

/** steer Action 判定（含类型收窄） */
export function isUserInputQueueAction(action: unknown): action is UserInputQueueActionType {
  return typeof action === "string" && USER_INPUT_QUEUE_ACTION_TYPES.has(action);
}

/**
 * enqueue 的业务字段（前端帧形态）：content 是聊天区内容块，出站前必须转成 peri 的
 * MessageContent（见 protocol/translator.ts 的 toPeriMessageContent）。
 */
export interface EnqueueUserInputPayload {
  /** 队列项标识（前端生成的 UUID，同时是 peri 侧的项键） */
  inputId: string;
  /** 聊天区内容块（ACP ContentBlock[]，图片为 {type:'image', mimeType, data}） */
  content: unknown;
  /** 用户原始草稿（纯文本）；空草稿缺省——出站补空串，取回回填时与缺省等价 */
  originalDraft?: string;
}

/** dispatch 的业务字段：空数组/非法项在 validateUserInputQueueAction 拒绝（不做空转往返） */
export interface DispatchUserInputsPayload {
  inputIds: string[];
}

/** takeback 的业务字段 */
export interface TakebackUserInputPayload {
  inputId: string;
}

export const ACTION_ACK_STATUSES = ["accepted", "committed", "duplicate"] as const;
export type ActionAckStatus = (typeof ACTION_ACK_STATUSES)[number];

/** 两阶段 Ack：accepted（进入有界队列）→ committed（业务事实已提交） */
export interface ActionAck {
  type: "action_ack";
  commandId: string;
  status: ActionAckStatus;
  turnId?: string;
  /**
   * create_session 的创建回执：本次请求在 Agent 侧确实创建出的 ACP session id。
   *
   * 只有发起该 create 的连接会收到它（Ack 按 sinks 定向投递），因此调用方可以据此把
   * 「点击后的归属」绑定到本页本次创建，而不必猜「共享 active session 为什么变了」。
   */
  sessionId?: string;
  committedProjectionVersion?: number;
}

/** Action 失败响应：commandId 仅用于协议关联，公开错误使用统一 DTO。 */
export interface ActionError {
  type: "action_error";
  commandId: string;
  error: PublicError;
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
  /** create_session 成功创建出的 ACP session id（Agent 响应回执，未拿到时缺省） */
  sessionId?: string;
}

/** Ack / Error 发送目标（通常为发起 Action 的连接） */
export interface ActionSinks {
  sendAck: (ack: ActionAck) => void;
  sendError: (error: ActionError) => void;
}

/** 业务校验边界的已分类失败；公开摘要由注册表产生。 */
export class CommandExecutionError extends Error {
  constructor(readonly publicErrorType: PublicErrorType) {
    super(publicErrorType);
    this.name = "CommandExecutionError";
  }
}

/** 单条命令的最大 payload 大小（JSON 序列化后），超过返回 PAYLOAD_TOO_LARGE */
export const MAX_ACTION_PAYLOAD_BYTES = 1024 * 1024;
