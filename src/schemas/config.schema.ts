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
export const ConfigBodySchema = z.object({
  action: ConfigActionSchema,
  name: z.string().optional(),
  modelId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
  source: z.string().optional(),
  workspaceId: z.string().optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  path: z.string().optional(),
  command: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  type: z.enum(["local", "remote", "disabled"]).optional(),
  /** inline provider 测试凭证 */
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  protocol: z.enum(["openai", "anthropic"]).optional(),
});

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

export const AgentInfoSchema = z.object({
  name: z.string(),
  builtIn: z.boolean(),
  model: z.string().nullable(),
  modelId: z.string().nullable(),
  description: z.string().nullable(),
  knowledgeBaseCount: z.number(),
});

export const AgentDetailSchema = z.object({
  name: z.string(),
  builtIn: z.boolean(),
  model: z.string().nullable(),
  modelId: z.string().nullable(),
  prompt: z.string().nullable(),
  description: z.string().nullable(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
  knowledge: z.unknown().nullable(),
  skillIds: z.array(z.string()).optional(),
  mcpIds: z.array(z.string()).optional(),
  machineId: z.string().nullable().optional(),
});

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
export type SkillInfo = z.infer<typeof SkillInfoSchema>;
export type SkillSourceInfo = z.infer<typeof SkillSourceInfoSchema>;
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;
export type McpServerDetail = z.infer<typeof McpServerDetailSchema>;
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;
export type McpInspectResult = z.infer<typeof McpInspectResultSchema>;
