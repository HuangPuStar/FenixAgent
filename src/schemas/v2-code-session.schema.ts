import * as z from "zod/v4";
import { SessionResponseSchema } from "./session.schema";

/** POST /v1/code/sessions — 创建 code session 请求体 */
export const CreateCodeSessionRequestSchema = z
  .object({
    environment_id: z.string().optional().describe("可选环境 ID；传入后将会话挂到指定环境下。"),
    title: z.string().optional().describe("可选会话标题。"),
    source: z.string().optional().describe("可选会话来源；服务端通常会强制写为 code。"),
    username: z.string().optional().describe("可选用户名展示字段。"),
  })
  .describe("创建 Code Session 的请求体。");

/** POST /v1/code/sessions — 创建 code session 响应 */
export const CreateCodeSessionResponseSchema = z
  .object({
    session: SessionResponseSchema.describe("新建后的会话信息。"),
  })
  .describe("创建 Code Session 的响应。");

/** POST /v1/code/sessions/:id/bridge — 获取连接信息 */
export const CodeSessionBridgeResponseSchema = z
  .object({
    api_base_url: z.string().describe("Worker 后续访问服务端时使用的 API 基础地址。"),
    worker_jwt: z.string().describe("供 worker/bridge 接入使用的短期 JWT。"),
    expires_in: z.number().describe("JWT 过期时间，单位秒。"),
  })
  .describe("Code Session bridge 连接信息响应。");

/** /v1/code/sessions/:id 路径参数 */
export const CodeSessionIdParamsSchema = z
  .object({
    id: z.string().describe("Code Session ID。"),
  })
  .describe("Code Session 路径参数。");

export type CreateCodeSessionRequest = z.infer<typeof CreateCodeSessionRequestSchema>;
export type CreateCodeSessionResponse = z.infer<typeof CreateCodeSessionResponseSchema>;
export type CodeSessionBridgeResponse = z.infer<typeof CodeSessionBridgeResponseSchema>;
