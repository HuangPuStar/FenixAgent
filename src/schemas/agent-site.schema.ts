import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

/** Agent Sites App 响应对象 */
export const AgentSiteAppSchema = z.object({
  id: z.string().describe("RCS 内 app UUID。"),
  organizationId: z.string().describe("所属组织 ID。"),
  userId: z.string().describe("创建者用户 ID（owner）。"),
  remoteAppId: z.string().describe("agent-sites 远程 app id（形如 app-xxxxxxxx）。"),
  name: z.string().describe("展示名称。"),
  description: z.string().nullable().describe("描述。"),
  visibility: z.enum(["private", "org", "authenticated", "public"]).describe("业务前端可见性。"),
  appType: z.enum(["pocketbase", "custom"]).describe("App 类型。custom 类型需通过 deploy 接口部署 Deno 应用。"),
  entryFile: z.string().nullable().describe("当前入口文件（如 main.ts）。pocketbase 类型为 null。"),
  activeSlot: z.enum(["a", "b"]).nullable().describe("当前激活的部署槽位。pocketbase 类型为 null。"),
  deployedAt: z.number().nullable().describe("最后部署时间（秒级时间戳）。pocketbase 类型为 null。"),
  createdAt: z.number().describe("创建时间（秒级时间戳）。"),
  updatedAt: z.number().describe("更新时间（秒级时间戳）。"),
});

export type AgentSiteApp = z.infer<typeof AgentSiteAppSchema>;

/** GET /web/agent-sites/apps 列表响应 */
export const AgentSiteAppListResponseSchema = WebOkSchema(AgentSiteAppSchema.array()).describe("Site App 列表响应。");

/** GET/POST /web/agent-sites/apps/{id} 详情响应 */
export const AgentSiteAppDetailResponseSchema = WebOkSchema(AgentSiteAppSchema).describe("Site App 详情响应。");

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
  type: z
    .enum(["pocketbase", "custom"])
    .optional()
    .default("pocketbase")
    .describe("App 类型。custom 类型不创建 PocketBase，需后续 POST /apps/:id/deploy 部署 Deno 代码。"),
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
export const AgentSiteAppOkResponseSchema = WebOkSchema(z.null()).describe("无业务数据时的 Site App 成功响应。");

/** /web/agent-sites/apps/:id 参数 */
export const AgentSiteAppIdParamsSchema = z.object({
  id: z.string().uuid().describe("RCS 内 app UUID。"),
});

/** /web/agent-sites/apps/by-remote/:remoteAppId 参数 */
export const AgentSiteRemoteAppParamsSchema = z.object({
  remoteAppId: z.string().min(1).describe("agent-sites 远程 app id（形如 app-xxxxxxxx）。"),
});

/** /web/agent-sites/apps/:id/files/:path 参数 */
export const AgentSiteAppFileParamsSchema = z.object({
  id: z.string().uuid().describe("RCS 内 app UUID。"),
  path: z.string().min(1).describe("上传目标文件路径。"),
});

/** /web/agent-sites/agent-configs/:agentConfigId/sites 参数 */
export const AgentSiteAgentConfigParamsSchema = z.object({
  agentConfigId: z.string().describe("Agent 配置 ID。"),
});

/** /web/agent-sites/agent-configs/:agentConfigId/sites/:siteAppId 参数 */
export const AgentSiteBindingParamsSchema = z.object({
  agentConfigId: z.string().describe("Agent 配置 ID。"),
  siteAppId: z.string().describe("Site App 标识，支持 RCS UUID 或 remoteAppId。"),
});

/** POST /web/agent-sites/apps/:id/deploy 成功响应 */
export const AgentSiteDeployResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    files: z.number().describe("解压后的文件数。"),
    totalBytes: z.number().describe("解压后总字节数。"),
    entryFile: z.string().describe("入口文件名（main.ts 或 main.js）。"),
    slot: z.enum(["a", "b"]).describe("当前激活的部署槽位。"),
    deployedAt: z.number().describe("本次部署时间（秒级时间戳）。"),
  }),
});

export type AgentSiteDeployResponse = z.infer<typeof AgentSiteDeployResponseSchema>;
