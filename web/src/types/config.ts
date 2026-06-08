// === opencode 标准类型 ===

// === Permission 类型定义 ===

/** 开关型工具的三态值 */
export type PermissionAction = "ask" | "allow" | "deny";

/** 规则型工具的值：全局策略字符串 或 pattern→action 映射 */
export type RuleBasedPermission = PermissionAction | Record<string, PermissionAction>;

/** 完整的 PermissionConfig 对象模式 */
export interface PermissionObjectConfig {
  // 规则型工具（支持通配符匹配）
  read?: RuleBasedPermission;
  edit?: RuleBasedPermission;
  glob?: RuleBasedPermission;
  grep?: RuleBasedPermission;
  list?: RuleBasedPermission;
  bash?: RuleBasedPermission;
  task?: RuleBasedPermission;
  external_directory?: RuleBasedPermission;
  lsp?: RuleBasedPermission;
  skill?: RuleBasedPermission;
  // 开关型工具（仅支持三态字符串）
  todowrite?: PermissionAction;
  question?: PermissionAction;
  webfetch?: PermissionAction;
  websearch?: PermissionAction;
  codesearch?: PermissionAction;
  doom_loop?: PermissionAction;
}

/** PermissionConfig: 字符串模式（全局策略）或对象模式（按工具配置） */
export type PermissionConfig = PermissionAction | PermissionObjectConfig;

export interface AgentKnowledgePolicy {
  searchFirst?: boolean;
  maxResults?: number;
  defaultNamespaces?: string[];
}

export interface AgentKnowledgeConfig {
  knowledgeBaseIds: string[];
  policy?: AgentKnowledgePolicy | null;
}

export interface OpenCodeModel {
  name?: string;
  modalities?: {
    input?: ("text" | "image")[];
    output?: ("text" | "image")[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
  cost?: {
    input?: number;
    output?: number;
  };
  options?: Record<string, unknown>;
}

export interface OpenCodeProvider {
  npm: string;
  name?: string;
  options?: {
    apiKey?: string;
    baseURL?: string;
    [key: string]: unknown;
  };
  models?: Record<string, OpenCodeModel>;
}

export interface OpenCodeAgent {
  model?: string;
  steps?: number;
  mode?: "primary" | "subagent" | "all";
  prompt?: string;
  tools?: string[];
  permission?: PermissionConfig;
  knowledge?: AgentKnowledgeConfig | null;
}

// === MCP 类型定义 ===

/** OAuth 认证配置 */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

/** 本地 MCP 服务器配置（命令行启动） */
export interface McpLocalConfig {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

/** 远程 MCP 服务器配置（URL 连接） */
export interface McpRemoteConfig {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
}

/** MCP 服务器配置联合类型（含禁用变体） */
export type McpServerConfig = McpLocalConfig | McpRemoteConfig | { enabled: false };

export interface OpenCodeConfig {
  $schema?: string;
  model?: string;
  small_model?: string;
  provider?: Record<string, OpenCodeProvider>;
  agent?: Record<string, OpenCodeAgent>;
  experimental?: Record<string, unknown>;
  plugin?: string[];
  mcp?: Record<string, McpServerConfig>;
  theme?: string;
}

// === API 响应类型 ===

// --- Providers ---

export interface ProviderInfo {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  keyHint: string | null;
  baseURL: string | null;
  modelCount: number;
  resourceAccess?: ResourceAccess;
  resourceKey?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  modalities: unknown;
  limit: unknown;
  cost: unknown;
  options?: Record<string, unknown>;
  providerResourceAccess?: ResourceAccess;
  providerResourceKey?: string;
}

export interface ProviderDetail {
  id: string;
  name: string;
  protocol: "openai" | "anthropic";
  keyHint: string | null;
  baseURL: string | null;
  options: Record<string, unknown>;
  models: ProviderModel[];
  resourceAccess?: ResourceAccess;
  resourceKey?: string;
}

// --- Models ---

export interface ModelEntry {
  id: string;
  modelId: string;
  displayName: string;
  provider: string;
  providerDisplayName: string;
  contextLimit: number | null;
  outputLimit: number | null;
  providerResourceAccess?: ResourceAccess;
  providerResourceKey?: string;
}

export interface ModelConfig {
  current: {
    model: string | null;
    small_model: string | null;
    permission: PermissionConfig | null;
  };
  available: ModelEntry[];
}

// --- Agents ---

export interface AgentInfo {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelId: string | null;
  modelLabel?: string | null;
  mode: string | null;
  description: string | null;
  color: string | null;
  knowledgeBaseCount: number;
  skillLabels?: Array<{ id: string; label: string }>;
  resourceAccess?: ResourceAccess;
  enabled?: boolean;
}

export interface AgentDetail {
  id?: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelId: string | null;
  prompt: string | null;
  tools: Record<string, boolean> | null;
  steps: number | null;
  mode: string | null;
  permission: PermissionConfig | null;
  variant: string | null;
  temperature: number | null;
  top_p: number | null;
  disable: boolean;
  hidden: boolean;
  color: string | null;
  description: string | null;
  knowledge: AgentKnowledgeConfig | null;
  skillIds?: string[];
  machineId?: string | null;
  relatedResources?: {
    modelLabel?: string | null;
    machineLabel?: string | null;
    skills?: Array<{ id: string; label: string }>;
    knowledgeBases?: Array<{ id: string; label: string; slug?: string | null }>;
  };
  resourceAccess?: ResourceAccess;
}

// --- Skills ---

export interface ResourceAccess {
  ownership: "internal" | "external";
  sourceOrganizationId: string;
  sourceOrganizationName?: string;
  resourceUid: string;
  resourceKey: string;
  manageable: boolean;
  writable: boolean;
  publicReadable?: boolean;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
  resourceAccess?: ResourceAccess;
}

export interface SkillDetail {
  name: string;
  description: string;
  content: string;
  path: string;
  metadata: Record<string, string>;
  resourceAccess?: ResourceAccess;
}

export interface UploadManifestEntry {
  skillName: string;
  relativePath: string;
}

export interface UploadSkillFileItem {
  relativePath: string;
  file: File;
}

export interface UploadSkillSummary {
  skillName: string;
  fileCount: number;
  hasSkillMd: boolean;
  files: UploadSkillFileItem[];
}

export type SkillUploadConflictStrategy = "ignore" | "overwrite";

export interface SkillUploadResponse {
  imported: SkillInfo[];
  skipped: string[];
  conflicts: SkillUploadConflict[];
}

export interface SkillUploadConflict {
  name: string;
  enabled: boolean;
  path: string;
}

export interface SkillUploadConflictResponse {
  conflicts: SkillUploadConflict[];
  allowedStrategies: SkillUploadConflictStrategy[];
}

// --- MCP ---

/** 用于前端列表展示的 MCP 服务器信息 */
export interface McpServerInfo {
  name: string;
  type: "local" | "remote" | "disabled";
  enabled: boolean;
  summary: string;
  timeout?: number;
  toolsCount?: number;
  resourceAccess?: ResourceAccess;
  resourceKey?: string;
}

/** MCP 服务器详情（编辑用） */
export interface McpServerDetail {
  name: string;
  config: McpServerConfig;
  enabled?: boolean;
  summary?: string;
  resourceAccess?: ResourceAccess;
  resourceKey?: string;
}

/** MCP Tool 缓存记录 */
export interface McpToolInfo {
  id: string;
  toolName: string;
  description: string | null;
  inputSchema: string | null;
  inspectedAt: number;
}

/** MCP 检测结果 */
export interface McpInspectResult {
  name: string;
  serverInfo: { name?: string; version?: string };
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  transport?: "streamable-http" | "sse";
  stored: boolean;
}

// === Generic API Response ===

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}
