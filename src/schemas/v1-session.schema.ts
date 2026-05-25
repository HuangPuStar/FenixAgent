import * as z from "zod/v4";
import { StatusOkResponseSchema } from "./common.schema";
import { SessionResponseSchema } from "./session.schema";

/** POST /v1/sessions — 创建 session 请求体 */
export const CreateSessionRequestSchema = z.object({
  environment_id: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  username: z.string().optional(),
  events: z.array(z.record(z.string(), z.unknown())).optional(),
});

/** PATCH /v1/sessions/:id — 更新 session 标题 */
export const UpdateSessionRequestSchema = z.object({
  title: z.string().min(1).optional(),
});

/** POST /v1/sessions/:id/events — 向 session 发送事件 */
export const SendEventsRequestSchema = z.object({
  events: z.union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown())]).optional(),
});

/** POST /v1/sessions — 创建会话响应 */
export const V1CreateSessionResponseSchema = SessionResponseSchema;

/** GET /v1/sessions/:id — 获取会话响应 */
export const V1GetSessionResponseSchema = SessionResponseSchema;

/** POST /v1/sessions/:id/archive — 归档响应 */
export const V1ArchiveSessionResponseSchema = StatusOkResponseSchema;

/** POST /v1/sessions/:id/events — 发送事件响应 */
export const V1SendEventsResponseSchema = z.object({
  status: z.literal("ok"),
  events: z.number(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;
export type SendEventsRequest = z.infer<typeof SendEventsRequestSchema>;
export type V1CreateSessionResponse = z.infer<typeof V1CreateSessionResponseSchema>;
export type V1GetSessionResponse = z.infer<typeof V1GetSessionResponseSchema>;
export type V1ArchiveSessionResponse = z.infer<typeof V1ArchiveSessionResponseSchema>;
export type V1SendEventsResponse = z.infer<typeof V1SendEventsResponseSchema>;
