/**
 * sessions.ts — 会话与控制域 API 模块
 *
 * 封装会话的列表/创建/详情/历史以及控制指令（send_event、control、interrupt）。
 * 后端使用 POST /web/sessions 和 POST /web/control 的 action 分发模式，域模块内部抽象为具名方法。
 */

import { request } from "./request";

/** 单个会话事件 */
export interface SessionEvent {
  [key: string]: unknown;
  seqNum?: number;
  type: string;
  payload?: Record<string, unknown>;
}

/** 会话响应 */
export interface SessionResponse {
  id: string;
  title?: string;
  environment_id?: string;
  status?: string;
  created_at?: number;
}

/** 会话列表响应 */
export type SessionListResponse = SessionResponse[];

/** 会话历史响应（包含事件数组） */
export interface SessionHistory {
  events: SessionEvent[];
}

/** send_event / control / interrupt 的通用响应类型 */
type ControlResponse = Record<string, unknown>;

/** 会话事件载荷 */
export type SessionEventPayload = Record<string, unknown>;

/** 会话查询参数 */
export interface SessionParams {
  sessionId: string;
}

export const sessionApi = {
  /** 获取会话列表 */
  list: () =>
    request<SessionListResponse>("/web/sessions", {
      method: "POST",
      body: { action: "list" },
    }),

  /** 创建新会话 */
  create: (body: Record<string, unknown>) =>
    request<SessionResponse>("/web/sessions", {
      method: "POST",
      body: { action: "create", ...body },
    }),

  /** 获取单个会话详情 */
  get: (params: SessionParams) =>
    request<SessionResponse>("/web/sessions", {
      method: "POST",
      body: { action: "get", sessionId: params.sessionId },
    }),

  /** 获取会话事件历史 */
  history: (params: SessionParams) =>
    request<SessionHistory>("/web/sessions", {
      method: "POST",
      body: { action: "history", sessionId: params.sessionId },
    }),
};

export const controlApi = {
  /** 向会话发送自定义事件 */
  sendEvent: (params: SessionParams, payload: SessionEventPayload) =>
    request<ControlResponse>("/web/control", {
      method: "POST",
      body: { action: "send_event", sessionId: params.sessionId, ...payload },
    }),

  /** 向会话发送控制指令 */
  control: (params: SessionParams, payload: SessionEventPayload) =>
    request<ControlResponse>("/web/control", {
      method: "POST",
      body: { action: "control", sessionId: params.sessionId, ...payload },
    }),

  /** 中断会话当前执行 */
  interrupt: (params: SessionParams) =>
    request<ControlResponse>("/web/control", {
      method: "POST",
      body: { action: "interrupt", sessionId: params.sessionId },
    }),
};
