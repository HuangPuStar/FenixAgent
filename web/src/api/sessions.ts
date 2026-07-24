/**
 * sessions.ts — 会话与控制域 API 模块
 *
 * 封装会话的列表/详情/历史以及控制指令（send_event、control、interrupt）。
 * 后端使用 RESTful 风格（GET 查询，POST 控制），域模块内部抽象为具名方法。
 */

import { request } from "./request";

/** 单个会话事件（与后端 SessionEventSchema 对齐）。
 *  SSE 实时推送的事件可能额外携带 direction、seqNum 等运行时字段，
 *  但 REST /history 端点仅返回 schema 声明的字段。 */
export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

/** 会话响应（与后端 SessionListItemSchema / SessionDetailSchema 对齐） */
export interface SessionResponse {
  id: string;
  title: string | null;
  status: string;
  environment_id: string | null;
  agent_name: string | null;
  source: string | null;
  created_at: number;
  updated_at: number;
}

/** 会话列表响应 */
export type SessionListResponse = SessionResponse[];

/** 会话历史响应（包含事件数组） */
export interface SessionHistory {
  events: SessionEvent[];
}

/** sendEvent / control 的成功响应（与后端 SendEventResponseSchema 对齐） */
type SendEventResponse = { status: "ok"; event: SessionEvent };

/** 会话事件载荷 */
export type SessionEventPayload = Record<string, unknown>;

/** 会话查询参数 */
export type SessionParams = { sessionId: string };

export const sessionApi = {
  /** 获取会话列表（GET /sessions） */
  list: () => request<SessionListResponse>("/web/sessions", { method: "GET" }),

  /** 获取单个会话详情（GET /sessions/:id） */
  get: (params: SessionParams) => request<SessionResponse>("/web/sessions/:sessionId", { method: "GET", params }),

  /** 获取会话事件历史（GET /sessions/:id/history） */
  history: (params: SessionParams) =>
    request<SessionHistory>("/web/sessions/:sessionId/history", { method: "GET", params }),
};

export const controlApi = {
  /** 向会话发送自定义事件（POST /sessions/:id/events） */
  sendEvent: (params: SessionParams, payload: SessionEventPayload) =>
    request<SendEventResponse>("/web/sessions/:sessionId/events", {
      method: "POST",
      params,
      body: payload,
    }),

  /** 向会话发送控制指令（POST /sessions/:id/control） */
  control: (params: SessionParams, payload: SessionEventPayload) =>
    request<SendEventResponse>("/web/sessions/:sessionId/control", {
      method: "POST",
      params,
      body: payload,
    }),

  /** 中断会话当前执行（POST /sessions/:id/interrupt） */
  interrupt: (params: SessionParams) =>
    request<void>("/web/sessions/:sessionId/interrupt", {
      method: "POST",
      params,
    }),
};
