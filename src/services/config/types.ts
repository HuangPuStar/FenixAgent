/**
 * types.ts — Config entity type definitions for JSONB columns.
 *
 * These types provide compile-time safety for config data flowing through
 * service functions, route handlers, and the config API. They mirror the
 * frontend types in web/src/types/config.ts; keep both in sync.
 */

// ────────────────────────────────────────────
// Permission
// ────────────────────────────────────────────

/** Three-state permission action */
export type PermissionAction = "ask" | "allow" | "deny";

/** Rule-based tool permission: global action or glob-pattern → action mapping */
export type RuleBasedPermission = PermissionAction | Record<string, PermissionAction>;

/** Per-tool permission configuration object */
export interface PermissionObjectConfig {
  // Rule-based tools (support glob patterns)
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
  // Switch-type tools (only tri-state string)
  todowrite?: PermissionAction;
  question?: PermissionAction;
  webfetch?: PermissionAction;
  websearch?: PermissionAction;
  codesearch?: PermissionAction;
  doom_loop?: PermissionAction;
}

/** Permission config: global action string or per-tool object */
export type PermissionConfig = PermissionAction | PermissionObjectConfig;

// ────────────────────────────────────────────
// Resource Access
// ────────────────────────────────────────────

/** Unified resource ownership and access metadata. */
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

/** Minimal config row shape used to decorate resource access metadata. */
export interface ResourceAccessInput {
  id: string;
  organizationId: string;
  name?: string | null;
}

// ────────────────────────────────────────────
// Agent Knowledge
// ────────────────────────────────────────────

export interface AgentKnowledgePolicy {
  searchFirst?: boolean;
  maxResults?: number;
  defaultNamespaces?: string[];
}

export interface AgentKnowledgeConfig {
  knowledgeBaseIds: string[];
  policy?: AgentKnowledgePolicy | null;
}

/** Extensible agent config bag for future UI/runtime metadata. */
export type AgentExtraConfig = Record<string, unknown>;

// ────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────

/** Provider extra options stored in provider.extra_options JSONB */
export type ProviderExtraOptions = Record<string, unknown>;

/** Data shape accepted by upsertProvider */
export interface ProviderUpsertData {
  displayName?: string | null;
  protocol?: "openai" | "anthropic";
  baseUrl?: string | null;
  apiKey?: string | null;
  extraOptions?: ProviderExtraOptions | null;
}

/** Additional options accepted by provider writes. */
export interface ProviderSetOptions {
  publicReadable?: boolean;
}

/** Minimal provider identity with resource access metadata. */
export interface ProviderResourceRef {
  id: string;
  name: string;
  organizationId: string;
  resourceAccess: ResourceAccess;
}

// ────────────────────────────────────────────
// Model
// ────────────────────────────────────────────

/** Model modalities — input/output capability arrays (object form) or plain string array */
export type ModelModalities =
  | {
      input?: ("text" | "image")[];
      output?: ("text" | "image")[];
    }
  | string[];

/** Model limit configuration */
export interface ModelLimitConfig {
  context?: number;
  output?: number;
  rpm?: number;
  [key: string]: unknown;
}

/** Model cost configuration */
export interface ModelCostConfig {
  input?: number;
  output?: number;
}

/** Model options — provider-specific parameters */
export type ModelOptions = Record<string, unknown>;

/** Data shape for adding/updating a model */
export interface ModelUpsertData {
  modelId?: string;
  displayName?: string;
  modalities?: ModelModalities | null;
  limitConfig?: ModelLimitConfig | null;
  cost?: ModelCostConfig | null;
  options?: ModelOptions | null;
}

/** Data shape accepted by buildModelData (maps frontend field names to PG columns) */
export interface ModelDataInput {
  name?: string;
  modalities?: unknown;
  limit?: unknown;
  cost?: unknown;
  options?: unknown;
}

/** Model row decorated with the access metadata inherited from its provider. */
export interface ModelEntryWithProviderAccess {
  id: string;
  providerId: string;
  organizationId: string;
  modelId: string;
  displayName: string | null;
  modalities: unknown;
  limitConfig: unknown;
  cost: unknown;
  options: unknown;
  providerResourceAccess: ResourceAccess;
}

// ────────────────────────────────────────────
// MCP Server
// ────────────────────────────────────────────

/** MCP server type discriminator */
export type McpServerType = "local" | "remote" | "streamable-http";

/** OAuth configuration for remote MCP servers */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

/** Local MCP server config (command-based) */
export interface McpLocalConfig {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

/** Remote MCP server config (URL-based, SSE transport) */
export interface McpRemoteConfig {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
}

/** Streamable HTTP MCP server config */
export interface McpStreamableHttpConfig {
  type: "streamable-http";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeout?: number;
}

/** Disabled MCP server config (minimal) */
export interface McpDisabledConfig {
  enabled: false;
}

/** Union of all MCP server config variants */
export type McpServerConfig = McpLocalConfig | McpRemoteConfig | McpStreamableHttpConfig | McpDisabledConfig;

/** Server info returned to frontend for list display */
export interface McpServerInfoOutput {
  name: string;
  type: "local" | "remote" | "streamable-http" | "disabled";
  enabled: boolean;
  summary: string;
  timeout?: number;
  resourceAccess?: ResourceAccess;
  resourceKey?: string;
}

/** Additional options accepted by MCP writes. */
export interface McpServerSetOptions {
  publicReadable?: boolean;
}

// ────────────────────────────────────────────
// Skill
// ────────────────────────────────────────────

/** Skill metadata stored in skill.metadata JSONB */
export type SkillMetadata = Record<string, string>;

/** Data shape accepted by upsertSkill */
export interface SkillUpsertData {
  description?: string;
  metadata?: SkillMetadata;
}

/** Skill config row decorated with resource access metadata. */
export interface SkillConfigRowWithAccess {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  description: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  resourceAccess: ResourceAccess;
}

/** Additional options accepted by skill writes. */
export interface SkillSetOptions {
  publicReadable?: boolean;
  auditAction?: "set" | "upload_create" | "upload_overwrite";
}

// ────────────────────────────────────────────
// User Config
// ────────────────────────────────────────────

/** User config data (preferences per organization) */
export interface UserConfigData {
  defaultAgent?: string | null;
  currentModel?: string | null;
  smallModel?: string | null;
  permission?: PermissionConfig | null;
}

// ────────────────────────────────────────────
// Agent Config
// ────────────────────────────────────────────

/** Data shape for creating/updating an agent config */
export interface AgentConfigUpsertData {
  modelId?: string | null;
  prompt?: string | null;
  description?: string | null;
  extra?: AgentExtraConfig | null;
  knowledge?: AgentKnowledgeConfig | null;
  machineId?: string | null;
  skillIds?: string[];
  mcpIds?: string[];
}

/** Agent config row decorated with resource access metadata. */
export interface AgentConfigRowWithAccess {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  prompt: string | null;
  modelId: string | null;
  model: string | null;
  description: string | null;
  machineId: string | null;
  extra?: AgentExtraConfig | null;
  createdAt: Date;
  updatedAt: Date;
  resourceAccess: ResourceAccess;
}

/** Agent config detail returned to the frontend with resolved access metadata. */
export interface AgentConfigDetailWithAccess extends AgentConfigRowWithAccess {
  skillIds?: string[];
  mcpIds?: string[];
}
