import { ResourceAccessViewSchema, WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * Agent 配置的协议模型。
 *
 * `AgentInfoSchema` / `AgentDetailSchema` 是**对外 `/api` 合同**的视图模型（含已发布合同的
 * `resourceAccess` 字段形状，由 `toResourceAccessView` 从 `scope + access.actions` 派生）。`/web`
 * 响应自决策 D2 起改为返回 `scope + access`，其形状由授权栈决定，因此 `/web` 路由用宽松对象承接，
 * 不再在此声明一份会与授权视图漂移的字段清单。
 */

export const AgentLabelSchema = z
  .object({
    id: z.string().describe("关联资源 ID。"),
    label: z.string().describe("用于前端展示的资源名称。"),
  })
  .describe("关联资源标签。");

export const AgentKnowledgeBaseLabelSchema = z
  .object({
    id: z.string().describe("知识库 ID。"),
    label: z.string().describe("知识库名称。"),
    slug: z.string().nullable().optional().describe("知识库 slug；未设置时为 null。"),
  })
  .describe("Agent 绑定的知识库标签。");

export const AgentSiteAppLabelSchema = z
  .object({
    id: z.string().describe("Site App ID。"),
    label: z.string().describe("Site App 名称。"),
    remoteAppId: z.string().nullable().describe("远程 App ID（如 app-xxxx）；未解析到时为 null。"),
  })
  .describe("Agent 绑定的 Site App 标签。");

export const AgentKnowledgePolicySchema = z
  .object({
    searchFirst: z.boolean().optional().describe("是否优先检索知识库。"),
    maxResults: z.number().int().min(1).max(20).optional().describe("知识检索最多返回条数。"),
    defaultNamespaces: z.array(z.string()).optional().describe("默认检索命名空间列表。"),
  })
  .catchall(z.unknown())
  .describe("Agent 知识库检索策略。");

export const AgentKnowledgeConfigSchema = z
  .object({
    knowledgeBaseIds: z.array(z.string()).describe("绑定的知识库 ID 列表，按顺序生效。"),
    policy: AgentKnowledgePolicySchema.nullable().optional().describe("可选的知识检索策略。"),
  })
  .catchall(z.unknown())
  .describe("Agent 知识库绑定配置。");

export const AgentRelatedResourceViewSchema = z
  .object({
    modelLabel: z.string().nullable().describe("模型展示名称；无法解析时回退为 modelId 或 null。"),
    machineLabel: z.string().nullable().describe("机器展示名称；无法解析时回退为 machineId 或 null。"),
    skills: z.array(AgentLabelSchema).describe("关联 Skill 的展示列表。"),
    mcps: z.array(AgentLabelSchema).describe("关联 MCP Server 的展示列表。"),
    knowledgeBases: z.array(AgentKnowledgeBaseLabelSchema).describe("关联知识库的展示列表。"),
    siteApps: z.array(AgentSiteAppLabelSchema).describe("关联 Site App 的展示列表。"),
  })
  .describe("Agent 关联资源展示视图。");

export const AgentNodeSchema = z.union([
  z.object({}).strict().describe("未显式指定执行节点，运行时按默认策略解析。"),
  z.object({ kind: z.literal("machine"), machineId: z.string().min(1) }),
  z.object({ kind: z.literal("sandbox"), sandboxPoolId: z.string().min(1) }),
]);

export const AgentInfoSchema = z
  .object({
    id: z.string().optional().describe("Agent 配置 ID。"),
    name: z.string().describe("Agent 名称。"),
    builtIn: z.boolean().describe("是否为系统内置 Agent。"),
    model: z.string().nullable().describe("兼容旧客户端的 provider/model 文本引用；未设置时为 null。"),
    modelId: z.string().nullable().describe("当前绑定的模型 ID；未设置时为 null。"),
    modelLabel: z.string().nullable().optional().describe("模型展示名称；仅列表场景返回。"),
    description: z.string().nullable().describe("Agent 描述；未设置时为 null。"),
    agentNode: AgentNodeSchema.describe("执行节点；空对象表示运行时按默认策略解析。"),
    knowledgeBaseCount: z.number().describe("绑定的知识库数量。"),
    skillLabels: z.array(AgentLabelSchema).optional().describe("Skill 展示标签列表；仅列表场景返回。"),
    resourceAccess: ResourceAccessViewSchema.optional().describe("跨组织共享时的资源访问控制信息。"),
  })
  .describe("Agent 列表项。");

export const AgentDetailSchema = z
  .object({
    id: z.string().optional().describe("Agent 配置 ID。"),
    name: z.string().describe("Agent 名称。"),
    builtIn: z.boolean().describe("是否为系统内置 Agent。"),
    model: z.string().nullable().describe("兼容旧客户端的 provider/model 文本引用；未设置时为 null。"),
    modelId: z.string().nullable().describe("当前绑定的模型 ID；未设置时为 null。"),
    prompt: z.string().nullable().describe("Agent 系统提示词；未设置时为 null。"),
    description: z.string().nullable().describe("Agent 描述；未设置时为 null。"),
    extra: z.record(z.string(), z.unknown()).nullable().optional().describe("额外扩展配置；未设置时为 null。"),
    knowledge: AgentKnowledgeConfigSchema.nullable().describe("知识库绑定配置；未设置时为 null。"),
    skillIds: z.array(z.string()).optional().describe("绑定的 Skill ID 列表。"),
    mcpIds: z.array(z.string()).optional().describe("绑定的 MCP Server ID 列表。"),
    siteAppIds: z.array(z.string()).optional().describe("绑定的 Site App ID 列表。"),
    agentNode: AgentNodeSchema.describe("执行节点；空对象表示运行时按默认策略解析。"),
    relatedResources: AgentRelatedResourceViewSchema.optional().describe("关联资源的展示视图。"),
    resourceAccess: ResourceAccessViewSchema.optional().describe("跨组织共享时的资源访问控制信息。"),
    enableMemory: z.boolean().optional().describe("是否为该 Agent 启用了 Hindsight 记忆功能。"),
  })
  .describe("Agent 详情。");

export const AgentTemplateSchema = z
  .object({
    id: z.string().describe("模板 ID。"),
    name: z.string().describe("模板名称。"),
    description: z.string().describe("模板描述。"),
    prompt: z.string().describe("模板默认 prompt。"),
    skills: z.array(z.string()).describe("模板默认绑定的 Skill 名称列表。"),
  })
  .describe("Agent 模板。");

export const AgentNameQuerySchema = z
  .object({
    name: z.string().min(1).optional().describe("Agent 名称或共享资源键。"),
  })
  .describe("Agent 查询参数。");

export const AgentMutationBodySchema = z
  .object({
    name: z.string().min(1).describe("要创建的 Agent 名称。"),
    data: z.record(z.string(), z.unknown()).describe("Agent 配置数据。"),
  })
  .describe("创建 Agent 请求体。");

export const UpdateAgentRequestSchema = z
  .object({
    data: z.record(z.string(), z.unknown()).describe("待更新的 Agent 字段。"),
  })
  .describe("更新 Agent 请求体。");

export const SetDefaultAgentRequestSchema = z
  .object({
    name: z.string().min(1).describe("要设为默认值的 Agent 名称或共享资源键。"),
  })
  .describe("设置默认 Agent 请求体。");

export const AgentTemplatesResponseSchema = WebOkSchema(
  z.object({
    templates: z.array(AgentTemplateSchema).describe("可用 Agent 模板列表。"),
  }),
).describe("Agent 模板列表响应。");

export const RestartAgentResponseSchema = WebOkSchema(
  z.object({
    environmentIds: z.array(z.string()).describe("绑定该 Agent 的 Environment ID。"),
    restartedInstanceIds: z.array(z.string()).describe("已完成 runtime 重启的持久 Agent Instance ID。"),
  }),
).describe("重启 Agent 运行实例响应。");

export const DeleteAgentResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: z.null().describe("删除操作成功后固定返回 null。"),
  })
  .describe("删除 Agent 响应。");

export type AgentTemplatesResponse = z.infer<typeof AgentTemplatesResponseSchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type AgentDetail = z.infer<typeof AgentDetailSchema>;
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;
export type AgentNameQuery = z.infer<typeof AgentNameQuerySchema>;
export type AgentMutationBody = z.infer<typeof AgentMutationBodySchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export type SetDefaultAgentRequest = z.infer<typeof SetDefaultAgentRequestSchema>;
