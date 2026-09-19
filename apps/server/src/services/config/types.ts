/**
 * types.ts — Config entity type definitions for JSONB columns.
 *
 * These types provide compile-time safety for config data flowing through
 * service functions, route handlers, and the config API. They mirror the
 * frontend types in apps/web/src/types/config.ts; keep both in sync.
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
// MCP Server
// ────────────────────────────────────────────

/**
 * MCP 配置模型的定义已随资源收拢到 `@fenix/resource-mcp`（资源包自持校验、类型归一与展示），
 * 宿主只是转发方，不在此重复声明——重复定义会让两侧的配置语义各自漂移。
 */
export type {
  McpDisabledConfig,
  McpLocalConfig,
  McpOAuthConfig,
  McpRemoteConfig,
  McpServerConfig,
  McpServerType,
  McpStreamableHttpConfig,
} from "@fenix/resource-mcp/server";

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
// Engine Type
// ────────────────────────────────────────────

/** Supported engine type identifiers */
export const ENGINE_TYPES = ["opencode", "ccb", "claude-code"] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];
