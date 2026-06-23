import * as z from "zod/v4";

/** Agent Sites App 响应对象 */
export const AgentSiteAppSchema = z.object({
  id: z.string().describe("RCS 内 app UUID。"),
  organizationId: z.string().describe("所属组织 ID。"),
  userId: z.string().describe("创建者用户 ID（owner）。"),
  remoteAppId: z.string().describe("agent-sites 远程 app id（形如 app-xxxxxxxx）。"),
  name: z.string().describe("展示名称。"),
  description: z.string().nullable().describe("描述。"),
  visibility: z.enum(["private", "org", "authenticated", "public"]).describe("业务前端可见性。"),
  createdAt: z.number().describe("创建时间（秒级时间戳）。"),
  updatedAt: z.number().describe("更新时间（秒级时间戳）。"),
});

export type AgentSiteApp = z.infer<typeof AgentSiteAppSchema>;

/** GET /web/agent-sites/apps 列表响应 */
export const AgentSiteAppListResponseSchema = z.object({
  success: z.literal(true),
  data: AgentSiteAppSchema.array(),
});

/** GET/POST /web/agent-sites/apps/{id} 详情响应 */
export const AgentSiteAppDetailResponseSchema = z.object({
  success: z.literal(true),
  data: AgentSiteAppSchema,
});

/** POST /web/agent-sites/apps 创建请求 */
export const CreateAgentSiteAppRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, "name 必须为 kebab-case")
    .describe("app 展示名称（kebab-case，仅展示用不唯一）。"),
  description: z.string().optional().describe("可选描述。"),
  visibility: z
    .enum(["private", "org", "authenticated", "public"])
    .optional()
    .default("private")
    .describe("业务前端可见性，默认 private。"),
});

export type CreateAgentSiteAppRequest = z.infer<typeof CreateAgentSiteAppRequestSchema>;

/** PATCH /web/agent-sites/apps/{id} 更新请求 */
export const UpdateAgentSiteAppRequestSchema = z.object({
  name: z.string().min(1).max(32).optional().describe("新的展示名称。"),
  description: z.string().optional().describe("新的描述。"),
  visibility: z.enum(["private", "org", "authenticated", "public"]).optional().describe("新的可见性。"),
});

export type UpdateAgentSiteAppRequest = z.infer<typeof UpdateAgentSiteAppRequestSchema>;

/** DELETE/POST rotate-token 等简单操作的成功响应 */
export const AgentSiteAppOkResponseSchema = z.object({
  success: z.literal(true),
});
