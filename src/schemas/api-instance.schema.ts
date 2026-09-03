import * as z from "zod/v4";

export const ApiInstanceAgentConfigParamsSchema = z
  .object({
    agentId: z.string().min(1).describe("Agent 配置 ID。"),
  })
  .describe("Agent Instance 连接路径参数。");

export const ApiInstanceConnectBodySchema = z
  .object({
    instanceUid: z
      .string()
      .startsWith("inst_")
      .optional()
      .describe("可选的持久 Agent Instance ID；省略时使用 api/primary。"),
  })
  .describe("连接 Agent Instance 请求体。");

export const ApiInstanceConnectResponseSchema = z
  .object({
    agentConfigId: z.string().describe("Agent 配置 ID。"),
    environmentId: z.string().describe("可连接的 Environment ID。"),
    instanceId: z.string().describe("当前连接的实例 ID。"),
    relay: z
      .object({
        wsUrl: z
          .string()
          .describe("ACP Relay WebSocket 相对路径；建议原样拼接，query 中的 instanceId 用于多实例环境精确指定实例。"),
      })
      .describe("建立 ACP 连接所需的 relay 信息。"),
  })
  .describe("连接 Agent Instance 响应。");

export type ApiInstanceConnectBody = z.infer<typeof ApiInstanceConnectBodySchema>;
