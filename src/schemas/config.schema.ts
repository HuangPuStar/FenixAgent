import * as z from "zod/v4";

// ── Config 通用结构 ──

const ConfigActionValues = [
  "list",
  "get",
  "set",
  "create",
  "delete",
  "update",
  "enable",
  "disable",
  "test",
  "test_model",
  "test_url",
  "add_model",
  "update_model",
  "remove_model",
  "set_default",
  "refresh",
  "inspect",
  "list_tools",
  "workspace_list",
  "templates",
] as const;

export const ConfigActionSchema = z.enum(ConfigActionValues);

/** Config 路由通用 body：宽松结构，handler 内部用 switch 分发 */
export const ConfigBodySchema = z
  .object({
    action: ConfigActionSchema.describe("配置动作名称。"),
    name: z.string().optional().describe("资源名称。"),
    modelId: z.string().optional().describe("模型 ID。"),
    data: z.record(z.string(), z.unknown()).optional().describe("配置动作附带的数据载荷。"),
    config: z.record(z.string(), z.unknown()).optional().describe("资源配置对象。"),
    url: z.string().optional().describe("远端资源 URL。"),
    headers: z.record(z.string(), z.string()).optional().describe("附加请求头。"),
    timeout: z.number().optional().describe("超时时间，单位为毫秒。"),
    source: z.string().optional().describe("配置来源标识。"),
    workspaceId: z.string().optional().describe("工作区 ID。"),
    content: z.string().optional().describe("原始文本内容。"),
    description: z.string().optional().describe("资源描述。"),
    enabled: z.boolean().optional().describe("资源启用状态。"),
    path: z.string().optional().describe("文件或目录路径。"),
    command: z.array(z.string()).optional().describe("命令数组。"),
    environment: z.record(z.string(), z.string()).optional().describe("环境变量字典。"),
    type: z.enum(["local", "remote", "disabled"]).optional().describe("MCP 服务类型。"),
    apiKey: z.string().optional().describe("inline provider 测试时使用的 API Key。"),
    baseURL: z.string().optional().describe("inline provider 测试时使用的 Base URL。"),
    protocol: z.enum(["openai", "anthropic"]).optional().describe("Provider 协议类型。"),
  })
  .describe("Config 路由通用请求体。");

// ── Providers ──

export const ProviderInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  keyHint: z.string().nullable(),
  baseURL: z.string().nullable(),
  modelCount: z.number(),
});

export const ProviderDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  keyHint: z.string().nullable(),
  baseURL: z.string().nullable(),
  options: z.record(z.string(), z.unknown()),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      modalities: z.unknown().nullable(),
      limit: z.unknown().nullable(),
      cost: z.unknown().nullable(),
    }),
  ),
});

// ── Models ──

export const ModelEntrySchema = z.object({
  id: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  provider: z.string(),
  providerDisplayName: z.string(),
  contextLimit: z.number().nullable(),
  outputLimit: z.number().nullable(),
});

export const ModelConfigSchema = z.object({
  current: z.object({
    model: z.string().nullable(),
    small_model: z.string().nullable(),
    permission: z.unknown().nullable(),
  }),
  available: ModelEntrySchema.array(),
});

// ── Agents ──

export const AgentResourceAccessSchema = z
  .object({
    ownership: z.string().describe("资源所有权类型，例如 internal 或 external。"),
    sourceOrganizationId: z.string().describe("资源来源组织 ID。"),
    sourceOrganizationName: z.string().optional().describe("资源来源组织名称。"),
    resourceUid: z.string().describe("资源唯一 ID。"),
    resourceKey: z.string().describe("跨组织可读的稳定资源键。"),
    manageable: z.boolean().describe("当前组织是否可管理该资源的共享属性。"),
    writable: z.boolean().describe("当前组织是否可修改该资源。"),
    publicReadable: z.boolean().optional().describe("该资源是否对其他组织公开可读。"),
  })
  .describe("Agent 资源访问控制信息。");

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
  })
  .describe("Agent 关联资源展示视图。");

export const AgentInfoSchema = z
  .object({
    id: z.string().optional().describe("Agent 配置 ID。"),
    name: z.string().describe("Agent 名称。"),
    builtIn: z.boolean().describe("是否为系统内置 Agent。"),
    model: z.string().nullable().describe("兼容旧客户端的 provider/model 文本引用；未设置时为 null。"),
    modelId: z.string().nullable().describe("当前绑定的模型 ID；未设置时为 null。"),
    modelLabel: z.string().nullable().optional().describe("模型展示名称；仅列表场景返回。"),
    description: z.string().nullable().describe("Agent 描述；未设置时为 null。"),
    machineId: z.string().nullable().optional().describe("绑定的机器 ID；未设置时为 null。"),
    knowledgeBaseCount: z.number().describe("绑定的知识库数量。"),
    skillLabels: z.array(AgentLabelSchema).optional().describe("Skill 展示标签列表；仅列表场景返回。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("跨组织共享时的资源访问控制信息。"),
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
    machineId: z.string().nullable().optional().describe("绑定的机器 ID；未设置时为 null。"),
    relatedResources: AgentRelatedResourceViewSchema.optional().describe("关联资源的展示视图。"),
    resourceAccess: AgentResourceAccessSchema.optional().describe("跨组织共享时的资源访问控制信息。"),
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

export const AgentTemplatesResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: z.object({
      templates: z.array(AgentTemplateSchema).describe("可用 Agent 模板列表。"),
    }),
  })
  .describe("Agent 模板列表响应。");

export const AgentListResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: z.object({
      default_agent: z.string().nullable().describe("当前用户的默认 Agent 名称；未设置时为 null。"),
      agents: z.array(AgentInfoSchema).describe("当前用户可见的 Agent 列表。"),
    }),
  })
  .describe("Agent 列表响应。");

export const AgentDetailResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: AgentDetailSchema.describe("指定 Agent 的详情。"),
  })
  .describe("Agent 详情响应。");

export const CreateAgentResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: z.object({
      name: z.string().describe("已创建的 Agent 名称。"),
      id: z.string().optional().describe("已创建的 Agent 配置 ID。"),
      resourceAccess: AgentResourceAccessSchema.optional().describe("创建后的共享访问控制信息。"),
    }),
  })
  .describe("创建 Agent 响应。");

export const UpdateAgentResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: z
      .object({
        name: z.string().describe("已更新的 Agent 名称。"),
        resourceAccess: AgentResourceAccessSchema.optional().describe("更新后的共享访问控制信息。"),
      })
      .catchall(z.unknown())
      .describe("更新后的 Agent 返回数据。"),
  })
  .describe("更新 Agent 响应。");

export const DeleteAgentResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: z.null().describe("删除操作成功后固定返回 null。"),
  })
  .describe("删除 Agent 响应。");

export const SetDefaultAgentResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
    data: z.object({
      default_agent: z.string().describe("已设置为默认值的 Agent 名称。"),
      resourceAccess: AgentResourceAccessSchema.optional().describe("该 Agent 的共享访问控制信息。"),
    }),
  })
  .describe("设置默认 Agent 响应。");

export const GetAgentResponseSchema = z
  .union([AgentListResponseSchema, AgentDetailResponseSchema])
  .describe("获取 Agent 列表或详情的响应。");

// ── Skills ──

export const SkillInfoSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  content: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});

export const SkillSourceInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  status: z.string(),
});

// ── MCP ──

export const McpServerInfoSchema = z.object({
  name: z.string(),
  type: z.enum(["local", "remote", "disabled"]),
  enabled: z.boolean(),
  summary: z.string(),
  timeout: z.number().optional(),
  toolsCount: z.number().optional(),
});

export const McpServerDetailSchema = z.object({
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
});

export const McpToolInfoSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  description: z.string().nullable(),
  inputSchema: z.string().nullable(),
  inspectedAt: z.number(),
});

export const McpInspectResultSchema = z.object({
  name: z.string(),
  serverInfo: z.object({
    name: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
  }),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable().optional(),
      inputSchema: z.unknown().optional(),
    }),
  ),
  transport: z.string().nullable().optional(),
  stored: z.boolean(),
});

export type ConfigAction = z.infer<typeof ConfigActionSchema>;
export type ConfigBody = z.infer<typeof ConfigBodySchema>;
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;
export type ProviderDetail = z.infer<typeof ProviderDetailSchema>;
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type AgentDetail = z.infer<typeof AgentDetailSchema>;
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;
export type AgentNameQuery = z.infer<typeof AgentNameQuerySchema>;
export type AgentMutationBody = z.infer<typeof AgentMutationBodySchema>;
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export type SetDefaultAgentRequest = z.infer<typeof SetDefaultAgentRequestSchema>;
export type SkillInfo = z.infer<typeof SkillInfoSchema>;
export type SkillSourceInfo = z.infer<typeof SkillSourceInfoSchema>;
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;
export type McpServerDetail = z.infer<typeof McpServerDetailSchema>;
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;
export type McpInspectResult = z.infer<typeof McpInspectResultSchema>;
