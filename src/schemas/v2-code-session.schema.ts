import * as z from "zod/v4";
import { SessionResponseSchema } from "./session.schema";

/** POST /v1/code/sessions — 创建 code session 请求体 */
export const CreateCodeSessionRequestSchema = z.object({
  environment_id: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  username: z.string().optional(),
});

/** POST /v1/code/sessions — 创建 code session 响应 */
export const CreateCodeSessionResponseSchema = z.object({
  session: SessionResponseSchema,
});

/** POST /v1/code/sessions/:id/bridge — 获取连接信息 */
export const CodeSessionBridgeResponseSchema = z.object({
  api_base_url: z.string(),
  worker_jwt: z.string(),
  expires_in: z.number(),
});

export type CreateCodeSessionRequest = z.infer<typeof CreateCodeSessionRequestSchema>;
export type CreateCodeSessionResponse = z.infer<typeof CreateCodeSessionResponseSchema>;
export type CodeSessionBridgeResponse = z.infer<typeof CodeSessionBridgeResponseSchema>;
