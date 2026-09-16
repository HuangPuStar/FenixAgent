import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";
import { ResourceAccessSchema } from "./resource-access.schema";

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
  /** 数据库主键；配置读写仍使用 id（Provider name）。 */
  providerId: z.string(),
  id: z.string(),
  name: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  keyHint: z.string().nullable(),
  baseURL: z.string().nullable(),
  modelCount: z.number(),
});

export const ProviderDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    protocol: z.enum(["openai", "anthropic"]),
    keyHint: z.string().nullable(),
    baseURL: z.string().nullable(),
    options: z.record(z.string(), z.unknown()),
    resourceAccess: z.lazy(() => ResourceAccessSchema).optional(),
    resourceKey: z.string().optional(),
    models: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        modalities: z.unknown().nullable(),
        limit: z.unknown().nullable(),
        cost: z.unknown().nullable(),
        providerResourceAccess: z.lazy(() => ResourceAccessSchema).optional(),
      }),
    ),
  })
  .describe("Provider 详情。");

// ── Provider REST 请求体 ──

/** POST /config/providers — 创建新 Provider 请求体 */
export const CreateProviderBodySchema = z
  .object({
    name: z.string().min(1).describe("Provider 名称。"),
    protocol: z.enum(["openai", "anthropic"]).optional().describe("Provider 协议类型。"),
    apiKey: z.string().optional().describe("Provider API Key。"),
    baseURL: z.string().optional().describe("Provider Base URL。"),
    displayName: z.string().optional().describe("Provider 展示名称。"),
    options: z.record(z.string(), z.unknown()).optional().describe("额外配置选项。"),
    publicReadable: z.boolean().optional().describe("是否对其他组织公开可读。"),
    models: z.record(z.string(), z.unknown()).optional().describe("Provider 下的模型配置。"),
  })
  .catchall(z.unknown())
  .describe("创建 Provider 请求体。");

/** PUT /config/providers/:name — 更新已有 Provider 请求体 */
export const UpdateProviderBodySchema = z
  .object({
    protocol: z.enum(["openai", "anthropic"]).optional().describe("Provider 协议类型。"),
    apiKey: z.string().optional().describe("Provider API Key。"),
    baseURL: z.string().optional().describe("Provider Base URL。"),
    displayName: z.string().optional().describe("Provider 展示名称。"),
    options: z.record(z.string(), z.unknown()).optional().describe("额外配置选项。"),
    publicReadable: z.boolean().optional().describe("是否对其他组织公开可读。"),
    models: z.record(z.string(), z.unknown()).optional().describe("Provider 下的模型配置。"),
  })
  .catchall(z.unknown())
  .describe("更新 Provider 请求体。");

/** POST /config/providers/actions/fetch-models — Provider 模型列表获取请求体 */
export const ProviderFetchModelsBodySchema = z
  .object({
    apiKey: z.string().optional().describe("内联测试用的 API Key。"),
    baseURL: z.string().optional().describe("内联测试用的 Base URL。"),
    protocol: z.enum(["openai", "anthropic"]).optional().describe("内联测试用的协议类型。"),
  })
  .describe("Provider 模型列表获取请求体。");

/** POST /config/providers/:name/models — 为 Provider 添加模型请求体 */
export const AddModelBodySchema = z
  .object({
    modelId: z.string().min(1).describe("模型 ID。"),
    data: z.record(z.string(), z.unknown()).describe("模型配置数据。"),
  })
  .describe("为 Provider 添加模型请求体。");

/** PUT /config/providers/:name/models/:modelId — 更新 Provider 下的模型请求体 */
export const UpdateModelBodySchema = z
  .object({
    data: z.record(z.string(), z.unknown()).describe("模型配置数据。"),
  })
  .describe("更新 Provider 下模型请求体。");

/** POST /config/providers/:name/models/test — 模型连通性测试请求体 */
export const TestModelBodySchema = z
  .object({
    modelId: z.string().min(1).describe("待测试的模型 ID。"),
  })
  .describe("模型连通性测试请求体。");

// ── Provider REST 响应 ──

/** Provider 列表响应 */
export const ProviderListResponseSchema = WebOkSchema(
  z.object({
    providers: z
      .array(
        ProviderInfoSchema.extend({
          resourceAccess: z
            .lazy(() => ResourceAccessSchema)
            .optional()
            .describe("跨组织共享时的资源访问控制信息。"),
          resourceKey: z.string().optional().describe("跨组织可读的稳定资源键。"),
        }),
      )
      .describe("Provider 列表。"),
  }),
).describe("Provider 列表响应。");

/** Provider 详情响应 */
export const ProviderDetailResponseSchema = WebOkSchema(ProviderDetailSchema).describe("Provider 详情响应。");

/** Provider 创建 / 更新响应 */
export const ProviderSaveResponseSchema = WebOkSchema(
  z.object({
    id: z.string().describe("Provider 名称。"),
    name: z.string().nullable().describe("Provider 展示名称。"),
    protocol: z.enum(["openai", "anthropic"]).describe("Provider 协议类型。"),
    keyHint: z.string().nullable().describe("API Key 提示信息。"),
  }),
).describe("Provider 创建 / 更新响应。");

/** Provider 模型列表获取响应 */
export const ProviderFetchModelsResponseSchema = WebOkSchema(
  z.object({
    models: z.array(z.string()).describe("Provider 提供的模型 ID 列表。"),
  }),
).describe("Provider 模型列表获取响应。");

/** 模型操作（添加/更新/删除）响应 */
export const ModelActionResultResponseSchema = WebOkSchema(
  z.object({
    modelId: z.string().describe("操作的模型 ID。"),
  }),
).describe("模型操作结果响应。");

/** 模型连通性测试响应 */
export const ModelTestResponseSchema = WebOkSchema(
  z.object({
    ok: z.boolean().describe("模型是否连通。"),
    content: z.string().describe("模型返回的测试消息内容。"),
  }),
).describe("模型连通性测试响应。");

// ── Models ──

export const ModelEntrySchema = z.object({
  id: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  provider: z.string(),
  providerDisplayName: z.string(),
  contextLimit: z.number().nullable(),
  outputLimit: z.number().nullable(),
  providerResourceAccess: z.unknown().optional(),
  providerResourceKey: z.string().optional(),
  modalities: z.unknown().nullable().optional(),
});

export const ModelConfigSchema = z.object({
  current: z.object({
    model: z.string().nullable(),
    small_model: z.string().nullable(),
    permission: z.unknown().nullable(),
  }),
  available: ModelEntrySchema.array(),
});

/** PUT /web/config/models 的请求体：更新用户模型偏好。 */
export const ModelPreferencesBodySchema = z
  .object({
    model: z.string().optional().describe("用户偏好的主模型引用（provider/model 格式）。"),
    small_model: z.string().optional().describe("用户偏好的轻量模型引用（provider/model 格式）。"),
    permission: z.unknown().optional().describe("用户权限配置对象。"),
  })
  .describe("模型偏好更新请求体。");

/** PUT /web/config/models 的响应体。 */
export const ModelPreferencesResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    model: z.string().nullable().describe("更新后的主模型引用。"),
    small_model: z.string().nullable().describe("更新后的轻量模型引用。"),
    permission: z.unknown().nullable().describe("更新后的权限配置。"),
  }),
});

/** POST /web/config/models/refresh 的响应体。 */
export const ModelRefreshResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    count: z.number().describe("刷新后可用模型数量。"),
  }),
});

// ── Skills ──

export const SkillInfoSchema = z
  .object({
    id: z.string().optional().describe("Skill ID。"),
    name: z.string().describe("Skill 名称。"),
    enabled: z.boolean().describe("Skill 是否启用。"),
    description: z.string().describe("Skill 描述。"),
    path: z.string().describe("Skill 源文件路径。"),
    resourceAccess: ResourceAccessSchema.optional().describe("该 Skill 的共享访问控制信息。"),
  })
  .describe("Skill 列表项。");

export const SkillDetailSchema = SkillInfoSchema.extend({
  content: z.string().describe("Skill Markdown 正文内容。"),
  metadata: z.record(z.string(), z.string()).describe("Skill frontmatter 元数据。"),
}).describe("Skill 详情。");

export const SkillListResponseSchema = WebOkSchema(
  z.object({
    skills: z.array(SkillInfoSchema).describe("当前组织可见的 Skill 列表。"),
  }),
).describe("Skill 列表响应。");

export const SkillSaveResultSchema = z
  .object({
    name: z.string().describe("已创建或更新的 Skill 名称。"),
    resourceAccess: ResourceAccessSchema.optional().describe("保存后的共享访问控制信息。"),
  })
  .describe("Skill 保存结果。");

export const CreateSkillResponseSchema = WebOkSchema(SkillSaveResultSchema).describe("创建 Skill 响应。");

export const UpdateSkillResponseSchema = WebOkSchema(SkillSaveResultSchema).describe("更新 Skill 响应。");

export const DeleteSkillResponseSchema = WebOkSchema(z.null()).describe("删除 Skill 响应。");

export const SkillUploadConflictSchema = z
  .object({
    name: z.string().describe("冲突的 Skill 名称。"),
    enabled: z.boolean().describe("冲突 Skill 当前是否启用。"),
    path: z.string().describe("冲突 Skill 的现有路径。"),
  })
  .describe("Skill 上传冲突项。");

export const SkillUploadResultSchema = z
  .object({
    imported: z.array(SkillInfoSchema).describe("本次成功导入的 Skill 列表。"),
    skipped: z.array(z.string()).describe("按策略跳过的 Skill 名称列表。"),
    conflicts: z.array(SkillUploadConflictSchema).describe("导入结果中残留的冲突列表。"),
  })
  .describe("Skill 批量上传结果。");

export const SkillUploadResponseSchema = WebOkSchema(SkillUploadResultSchema).describe("Skill 批量上传响应。");

export const SkillSourceInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  status: z.string(),
});

// ── MCP ──

export const McpServerInfoSchema = z.object({
  name: z.string(),
  type: z.enum(["local", "remote", "streamable-http", "disabled"]),
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
export type CreateProviderBody = z.infer<typeof CreateProviderBodySchema>;
export type UpdateProviderBody = z.infer<typeof UpdateProviderBodySchema>;
export type ProviderFetchModelsBody = z.infer<typeof ProviderFetchModelsBodySchema>;
export type AddModelBody = z.infer<typeof AddModelBodySchema>;
export type UpdateModelBody = z.infer<typeof UpdateModelBodySchema>;
export type TestModelBody = z.infer<typeof TestModelBodySchema>;
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type SkillInfo = z.infer<typeof SkillInfoSchema>;
export type SkillDetail = z.infer<typeof SkillDetailSchema>;
export type SkillListResponse = z.infer<typeof SkillListResponseSchema>;
export type SkillSaveResult = z.infer<typeof SkillSaveResultSchema>;
export type SkillUploadConflict = z.infer<typeof SkillUploadConflictSchema>;
export type SkillUploadResult = z.infer<typeof SkillUploadResultSchema>;
export type SkillSourceInfo = z.infer<typeof SkillSourceInfoSchema>;
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;
export type McpServerDetail = z.infer<typeof McpServerDetailSchema>;
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;
export type McpInspectResult = z.infer<typeof McpInspectResultSchema>;
