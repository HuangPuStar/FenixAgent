import * as z from "zod/v4";

/** POST /web/bind 请求体 */
export const BindSessionRequestSchema = z
  .object({
    sessionId: z.string().describe("待绑定的会话 ID。"),
    uuid: z.string().optional().describe("待绑定的用户唯一标识；兼容旧调用方，可通过 body 传入。"),
  })
  .describe("绑定会话归属关系的请求体。");

/** POST /web/bind 查询参数 */
export const BindSessionQuerySchema = z
  .object({
    uuid: z.string().optional().describe("待绑定的用户唯一标识；优先从 query 读取。"),
  })
  .describe("绑定会话时使用的查询参数。");

/** POST /web/bind 成功响应 */
export const BindSessionResponseSchema = z
  .object({
    ok: z.literal(true).describe("绑定是否成功。"),
    sessionId: z.string().describe("解析后的真实会话 ID。"),
  })
  .describe("绑定会话成功后的响应。");

export type BindSessionRequest = z.infer<typeof BindSessionRequestSchema>;
export type BindSessionQuery = z.infer<typeof BindSessionQuerySchema>;
export type BindSessionResponse = z.infer<typeof BindSessionResponseSchema>;
