import * as z from "zod/v4";

/** Meta Agent ensure 响应 */
export const EnsureMetaAgentResponseSchema = z.object({
  success: z.literal(true).describe("接口调用成功。"),
  data: z.object({
    environmentId: z.string().describe("Meta Agent 对应的环境 ID。"),
    instanceId: z.string().optional().describe("本次确保后可用的实例 ID；实例未成功拉起时可能缺失。"),
    status: z.enum(["created", "reused"]).describe("本次是新建环境还是复用已有环境。"),
    apiKey: z.string().optional().describe("Meta Agent 使用的 API Key；部分情况下可能不返回。"),
  }),
});

export type EnsureMetaAgentResponse = z.infer<typeof EnsureMetaAgentResponseSchema>;
