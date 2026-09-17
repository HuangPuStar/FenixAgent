import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";
/** 会话详情模型 */
export const SessionDetailSchema = z
  .object({
    id: z.string().describe("RCS 会话 ID。"),
    environment_id: z.string().nullable().describe("所属环境 ID；游离会话时为 null。"),
    agent_name: z.string().nullable().describe("运行时上报的 Agent 名称。"),
    title: z.string().nullable().describe("会话标题。"),
    status: z.string().describe("当前会话状态。"),
    source: z.string().nullable().describe("会话来源，例如 ui、relay。"),
    created_at: z.number().describe("会话创建时间，单位为秒级时间戳。"),
    updated_at: z.number().describe("会话更新时间，单位为秒级时间戳。"),
  })
  .describe("会话详情。");

/** 会话列表项模型 */
export const SessionListItemSchema = z
  .object({
    id: z.string().describe("RCS 会话 ID。"),
    title: z.string().nullable().describe("会话标题。"),
    status: z.string().describe("当前会话状态。"),
    environment_id: z.string().nullable().describe("所属环境 ID；游离会话时为 null。"),
    agent_name: z.string().nullable().describe("运行时上报的 Agent 名称。"),
    source: z.string().nullable().describe("会话来源，例如 ui、relay。"),
    created_at: z.number().describe("会话创建时间，单位为秒级时间戳。"),
    updated_at: z.number().describe("会话更新时间，单位为秒级时间戳。"),
  })
  .describe("会话列表项。");

/** 会话事件负载 */
export const SessionEventPayloadSchema = z.record(z.string(), z.unknown()).describe("会话事件负载。");

/** 会话事件模型 */
export const SessionEventSchema = z
  .object({
    id: z.string().describe("事件 ID。"),
    sessionId: z.string().describe("所属会话 ID。"),
    type: z.string().describe("事件类型。"),
    timestamp: z.number().describe("事件时间，单位为毫秒级时间戳。"),
    payload: SessionEventPayloadSchema.describe("事件负载内容。"),
  })
  .describe("会话事件。");

/** 会话历史响应模型 */
export const SessionHistoryDataSchema = z
  .object({
    events: SessionEventSchema.array().describe("按时间顺序返回的会话事件列表。"),
  })
  .describe("会话事件历史数据。");

/** GET /web/sessions — 会话列表响应 */
export const SessionListResponseSchema = WebOkSchema(SessionListItemSchema.array().describe("会话列表。")).describe(
  "会话列表响应。",
);

/** GET /web/sessions/:id — 会话详情响应 */
export const SessionDetailResponseSchema = WebOkSchema(SessionDetailSchema).describe("会话详情响应。");

/** GET /web/sessions/:id/history — 会话历史响应 */
export const SessionHistorySchema = WebOkSchema(SessionHistoryDataSchema).describe("会话历史响应。");

/** POST /web/sessions/:id/events / control — 事件发送响应 */
export const SendEventDataSchema = z
  .object({
    status: z.literal("ok").describe("操作状态。"),
    event: SessionEventSchema.describe("后端接收并返回的事件。"),
  })
  .describe("发送会话事件后的响应数据。");

export const SendEventResponseSchema = WebOkSchema(SendEventDataSchema).describe("发送会话事件后的响应。");

export const SessionResponseSchema = SessionDetailResponseSchema;
export const SessionSummarySchema = SessionListItemSchema;

export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionHistoryData = z.infer<typeof SessionHistoryDataSchema>;
export type SessionHistory = z.infer<typeof SessionHistorySchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SendEventResponse = z.infer<typeof SendEventResponseSchema>;
