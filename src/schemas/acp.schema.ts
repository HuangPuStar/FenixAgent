import * as z from "zod/v4";

/** ACP Agent 列表项 */
export const AcpAgentSchema = z
  .object({
    id: z.string().describe("ACP Agent 对应的环境 ID。"),
    agent_name: z.string().nullable().describe("Agent 名称；未上报时为 null。"),
    status: z.enum(["online", "offline"]).describe("当前 Agent 在线状态。"),
    max_sessions: z.number().describe("该 Agent 允许的最大会话数。"),
    last_seen_at: z.number().nullable().describe("最近心跳时间，单位为秒级时间戳；未知时为 null。"),
    created_at: z.number().describe("环境创建时间，单位为秒级时间戳。"),
  })
  .describe("ACP Agent 列表项。");

/** GET /acp/agents 响应 */
export const AcpAgentListResponseSchema = AcpAgentSchema.array().describe("当前组织下的 ACP Agent 列表。");

/** /acp/relay/:agentId 路径参数 */
export const AcpRelayParamsSchema = z
  .object({
    agentId: z.string().describe("要连接的 ACP Agent 对应环境 ID。"),
  })
  .describe("ACP Relay 路径参数。");

/** /acp/relay/:agentId 查询参数 */
export const AcpRelayQuerySchema = z
  .object({
    sessionId: z.string().optional().describe("可选会话 ID；传入后 relay 会尝试复用该会话。"),
  })
  .describe("ACP Relay 查询参数。");

/** /acp/ws 与 /acp/file-ws 查询参数 */
export const AcpRegistrySecretQuerySchema = z
  .object({
    secret: z.string().describe("机器侧接入使用的注册密钥，必须与服务端 REGISTRY_SECRET 匹配。"),
  })
  .describe("ACP 机器 WebSocket 接入查询参数。");

export type AcpAgent = z.infer<typeof AcpAgentSchema>;
export type AcpAgentListResponse = z.infer<typeof AcpAgentListResponseSchema>;
