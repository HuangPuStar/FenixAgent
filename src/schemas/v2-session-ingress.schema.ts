import * as z from "zod/v4";
import { StatusOkResponseSchema } from "./common.schema";

/** /v2/session_ingress/session/:sessionId/events 路径参数 */
export const SessionIngressParamsSchema = z
  .object({
    sessionId: z.string().describe("会话 ID。允许传入别名，服务端会自动解析到真实会话 ID。"),
  })
  .describe("Session Ingress 路径参数。");

/** session ingress 认证查询参数 */
export const SessionIngressTokenQuerySchema = z
  .object({
    token: z.string().optional().describe("可选 worker JWT；未提供时也可通过 Authorization Bearer 头传入。"),
  })
  .describe("Session Ingress 鉴权查询参数。");

/** Session ingress 单条事件 */
export const SessionIngressEventSchema = z
  .record(z.string(), z.unknown())
  .describe("桥接层接收的单条事件对象，字段由上游 worker/bridge 协议决定。");

/** POST /v2/session_ingress/session/:sessionId/events 请求体 */
export const SessionIngressEventsRequestSchema = z
  .union([
    z.object({
      events: z.array(SessionIngressEventSchema).describe("批量写入的事件列表。"),
    }),
    z.array(SessionIngressEventSchema).describe("直接传入事件数组。"),
    SessionIngressEventSchema,
  ])
  .describe("Session Ingress 事件上报请求体。");

/** POST /v2/session_ingress/session/:sessionId/events 响应 */
export const SessionIngressEventsResponseSchema = StatusOkResponseSchema.describe("Session Ingress 事件上报成功响应。");
