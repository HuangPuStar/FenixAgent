// 本文件是 6 个资源包（model-management / mcp / skill / agent-config / task / observer）
// web 面共用的类型契约，由宿主 `apps/web/src/types/config.ts` 逐字提升而来。
// 提升原因：包内 web 代码禁止引用宿主别名 `@/src/types/config`，共享类型必须经
// `@fenix/web-runtime/types/config` 复用，否则资源包无法脱离宿主独立编译。
// 纯类型模块，运行时无导出。宿主副本 `apps/web/src/types/config.ts` 已在共享文件波次删除，
// 全部消费方（`PermissionTab.tsx` 与 12 个宿主 lib / page / 测试模块）改指本出口。
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
  /** 是否对其他组织公开可读 */
  publicReadable?: boolean;
}

/** 远程 MCP 服务器配置（URL 连接） */
export interface McpRemoteConfig {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
  /** 是否对其他组织公开可读 */
  publicReadable?: boolean;
}

/** Streamable HTTP MCP 服务器配置 */
export interface McpStreamableHttpConfig {
  type: "streamable-http";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeout?: number;
}

/** MCP 服务器配置联合类型（含禁用变体） */
export type McpServerConfig = McpLocalConfig | McpRemoteConfig | McpStreamableHttpConfig | { enabled: false };

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

/**
 * 用于前端展示的 Provider 列表项。
 *
 * `scope` / `access` 是授权视图字段（见 {@link ResourceAccessView}）：`/web` 列表恒返回，因此声明为
 * 必填，消费点不得再回退读取旧栈的 `resourceAccess`。
 */
export interface ProviderInfo extends ResourceAccessView {
  /** 数据库主键；Provider 配置 API 的 id 字段仍表示名称。 */
  providerId: string;
  id: string;
  name: string;
  kind: "direct" | "gateway";
  gatewayType: string | null;
  protocol: "openai" | "anthropic";
  keyHint: string | null;
  baseURL: string | null;
  modelCount: number;
}

/** Provider 下的模型配置；模型不独立持有归属与授权，可访问性完全继承所属 Provider。 */
export interface ProviderModel {
  id: string;
  name: string;
  modalities: unknown;
  limit: unknown;
  cost: unknown;
  options?: Record<string, unknown>;
}

/** Provider 详情（编辑用）；`scope` / `access` 必填的原因同 {@link ProviderInfo}。 */
export interface ProviderDetail extends ResourceAccessView {
  id: string;
  name: string;
  kind: "direct" | "gateway";
  gatewayType: string | null;
  protocol: "openai" | "anthropic";
  keyHint: string | null;
  baseURL: string | null;
  models: ProviderModel[];
}

// --- Models ---

/**
 * 用于模型配置与 Agent 编辑器的可用模型条目。
 *
 * 模型不独立持有归属与授权：`scope` / `access` 一律继承所属 Provider（`providerId` 标识），
 * 消费点据此推导跨组织引用键与共享来源。声明为可选的原因同 {@link SkillInfo}。
 */
export interface ModelEntry extends Partial<ResourceAccessView> {
  id: string;
  modelId: string;
  displayName: string;
  /** 所属 Provider 的配置名（组织内唯一）。 */
  provider: string;
  /** 所属 Provider 的资源 UUID；与 `scope.organizationId` 缺一时跨组织引用退化为 `${provider}/${modelId}`。 */
  providerId?: string;
  providerDisplayName: string;
  contextLimit: number | null;
  outputLimit: number | null;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
  modalities?: unknown;
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

export type AgentNode =
  | { kind?: never; machineId?: never; sandboxPoolId?: never }
  | { kind: "machine"; machineId: string }
  | { kind: "sandbox"; sandboxPoolId: string };

/**
 * 用于前端展示的 Agent 列表项。
 *
 * `scope` / `access` 是授权视图字段，后端 `/web` 列表恒返回；声明为可选的原因同 {@link SkillInfo}
 * （消费点必须显式处理缺失情况，按「本组织私有、不可写」保守降级）。
 */
export interface AgentInfo extends Partial<ResourceAccessView> {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelId: string | null;
  modelLabel?: string | null;
  description: string | null;
  agentNode: AgentNode;
  knowledgeBaseCount: number;
  skillLabels?: Array<{ id: string; label: string }>;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
}

/** Agent 详情（编辑用）；`scope` / `access` 可选的原因同 {@link AgentInfo}。 */
export interface AgentDetail extends Partial<ResourceAccessView> {
  id?: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  modelId: string | null;
  prompt: string | null;
  description: string | null;
  extra?: Record<string, unknown> | null;
  knowledge: AgentKnowledgeConfig | null;
  skillIds?: string[];
  mcpIds?: string[];
  siteAppIds?: string[];
  agentNode: AgentNode;
  relatedResources?: {
    modelLabel?: string | null;
    machineLabel?: string | null;
    skills?: Array<{ id: string; label: string }>;
    mcps?: Array<{ id: string; label: string }>;
    knowledgeBases?: Array<{ id: string; label: string; slug?: string | null }>;
    siteApps?: Array<{ id: string; label: string; remoteAppId: string | null }>;
  };
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
  enableMemory?: boolean;
}

// --- 资源授权视图 ---

/** 资源归属范围：`organizationId` 缺失表示归属个人；`visibility` 决定是否对其他组织公开可读。 */
export interface ResourceScopeView {
  organizationId?: string;
  ownerUserId?: string;
  visibility: "private" | "public";
}

/** 当前主体对资源的有效动作集合；授权判断在服务端完成，前端只按动作做保守展示。 */
export type ResourceAccessActions = Array<"read" | "create" | "update" | "delete" | "use">;

/**
 * 资源授权视图：新授权栈下 `/web` 响应统一携带的 `scope` + `access` 组合。
 *
 * 旧字段 `resourceAccess` 是服务端预先算好的布尔结果；新视图把归属（`scope`）与有效动作
 * （`access.actions`）分开返回，前端判断必须基于 `scope.organizationId` 与动作集合自行推导，
 * 不得再回退读取 `resourceAccess`。
 */
export interface ResourceAccessView {
  scope: ResourceScopeView;
  access: { actions: ResourceAccessActions };
}

/**
 * 用于前端列表展示的 Skill 信息。
 *
 * `scope` / `access` 是授权视图字段，后端 `/web` 列表恒返回；声明为可选是为了让消费点必须显式
 * 处理缺失情况（缺失按「本组织私有、不可写」保守降级），避免部分响应或旧缓存导致越权展示。
 */
export interface SkillInfo extends Partial<ResourceAccessView> {
  id?: string;
  name: string;
  enabled: boolean;
  description: string;
  path: string;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
}

/** Skill 详情（编辑用）；`scope` / `access` 可选的原因同 {@link SkillInfo}。 */
export interface SkillDetail extends Partial<ResourceAccessView> {
  id?: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  path: string;
  metadata: Record<string, string>;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
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

/**
 * 用于前端列表展示的 MCP 服务器信息。
 *
 * `scope` / `access` 是授权视图字段，后端 `/web` 列表恒返回；声明为可选是为了让消费点必须显式
 * 处理缺失情况（缺失按「本组织私有、不可写」保守降级），避免部分响应或旧缓存导致越权展示。
 */
export interface McpServerInfo extends Partial<ResourceAccessView> {
  id: string;
  name: string;
  type: "local" | "remote" | "streamable-http" | "disabled";
  enabled: boolean;
  summary: string;
  timeout?: number;
  toolsCount?: number;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
}

/** MCP 服务器详情（编辑用）；`scope` / `access` 可选的原因同 {@link McpServerInfo}。 */
export interface McpServerDetail extends Partial<ResourceAccessView> {
  name: string;
  config: McpServerConfig;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
}

/** MCP Tool 缓存记录 */
export interface McpToolInfo {
  id: string;
  toolName: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
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
