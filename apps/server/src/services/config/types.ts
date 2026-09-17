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
// Resource Access
// ────────────────────────────────────────────

import type { ResourceAccess } from "@fenix/access-control/server";

export type { ResourceAccess, ResourceAccessInput } from "@fenix/access-control/server";

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
// Engine Type
// ────────────────────────────────────────────

/** Supported engine type identifiers */
export const ENGINE_TYPES = ["opencode", "ccb", "claude-code"] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];
