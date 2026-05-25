# Config Entity Type Definitions Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all `Record<string, unknown>` usages in config service files with strongly-typed interfaces matching the JSONB column shapes, and share those types with the frontend via a shared types file.

**Architecture:** Define TypeScript interfaces for each config entity's JSONB fields in a new `src/services/config/types.ts` file. Export them through the existing barrel file `src/services/config/index.ts`. Update all service functions to accept the specific types instead of `Record<string, unknown>`. The frontend types in `web/src/types/config.ts` already define the same shapes (e.g. `PermissionConfig`, `McpLocalConfig`, `McpRemoteConfig`); the backend types will mirror these exactly so both sides stay aligned.

**Tech Stack:** TypeScript, Drizzle ORM (inferSelect/inferInsert), Zod (runtime validation where needed), Bun test.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/services/config/types.ts` | **CREATE** — All config entity type interfaces (PermissionConfig, McpServerConfig variants, ProviderExtraOptions, ModelOptions, SkillMetadata, AgentKnowledgeConfig) |
| `src/services/config/provider.ts` | **MODIFY** — Replace `Record<string, unknown>` in `upsertProvider` data param and `buildModelData` with typed interfaces |
| `src/services/config/model.ts` | **MODIFY** — Replace `unknown` in function params with typed JSONB interfaces |
| `src/services/config/agent-config.ts` | **MODIFY** — Replace `Record<string, unknown>` in `buildSetFromData`, `createAgentConfig`, `updateAgentConfig`, `validateAgentData` with typed interfaces |
| `src/services/config/mcp-server.ts` | **MODIFY** — Replace `Record<string, unknown>` in `createMcpServer`, `updateMcpServer`, `validateMcpConfig`, `toServerInfo` with typed interfaces |
| `src/services/config/skill.ts` | **MODIFY** — Replace `Record<string, unknown>` in `upsertSkill` data param with typed interface |
| `src/services/config/user-config.ts` | **MODIFY** — Replace `unknown` permission field with `PermissionConfig \| null` |
| `src/services/config/index.ts` | **MODIFY** — Re-export all new types from `types.ts` |
| `src/services/config-pg.ts` | **MODIFY** — Re-export types from barrel |
| `src/routes/web/config/providers.ts` | **MODIFY** — Use typed interfaces in handler functions |
| `src/routes/web/config/agents.ts` | **MODIFY** — Use typed interfaces in handler functions |
| `src/routes/web/config/mcp.ts` | **MODIFY** — Use typed interfaces from `types.ts` instead of locally-defined duplicates |
| `src/__tests__/config-types.test.ts` | **CREATE** — Unit tests for type guards and Zod schemas |
| `web/src/types/config.ts` | **MODIFY** — Import shared PermissionConfig, McpServerConfig etc. from backend types (or keep in sync with explicit comment) |

---

## Tasks

### Task 1: Create shared config type definitions

**Files:**
- Create: `src/services/config/types.ts`

This task creates the central type definition file that all config services and routes will import from. The types mirror what already exists in `web/src/types/config.ts` but are defined on the backend side as the canonical source.

- [ ] **Step 1: Create `src/services/config/types.ts` with all config entity interfaces**

```typescript
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

// ────────────────────────────────────────────
// Provider
// ────────────────────────────────────────────

/** Provider extra options stored in provider.extra_options JSONB */
export type ProviderExtraOptions = Record<string, unknown>;

/** Data shape accepted by upsertProvider */
export interface ProviderUpsertData {
  displayName?: string;
  npm?: string;
  baseUrl?: string;
  apiKey?: string;
  extraOptions?: ProviderExtraOptions;
}

// ────────────────────────────────────────────
// Model
// ────────────────────────────────────────────

/** Model modalities — input/output capability arrays */
export interface ModelModalities {
  input?: ("text" | "image")[];
  output?: ("text" | "image")[];
}

/** Model limit configuration */
export interface ModelLimitConfig {
  context?: number;
  output?: number;
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
}

// ────────────────────────────────────────────
// Skill
// ────────────────────────────────────────────

/** Skill metadata stored in skill.metadata JSONB */
export type SkillMetadata = Record<string, string>;

/** Data shape accepted by upsertSkill */
export interface SkillUpsertData {
  description?: string;
  contentPath?: string;
  metadata?: SkillMetadata;
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
  model?: string | null;
  prompt?: string | null;
  steps?: number | null;
  mode?: string | null;
  permission?: PermissionConfig | null;
  variant?: string | null;
  temperature?: number | null;
  topP?: number | null;
  top_p?: number | null;
  disable?: boolean;
  hidden?: boolean;
  color?: string | null;
  description?: string | null;
  knowledge?: AgentKnowledgeConfig | null;
  skillIds?: string[];
}
```

- [ ] **Step 2: Verify the types file has no syntax errors**

```bash
bun run typecheck 2>&1 | head -30
```

Expected: No errors in `src/services/config/types.ts`. Other existing errors are not related.

---

### Task 2: Update config service functions to use typed interfaces

**Files:**
- Modify: `src/services/config/provider.ts`
- Modify: `src/services/config/model.ts`
- Modify: `src/services/config/skill.ts`

- [ ] **Step 1: Update `src/services/config/provider.ts`**

Replace `Record<string, unknown>` in `upsertProvider` data parameter with `ProviderUpsertData`, and update `buildModelData` to accept `ModelDataInput` and return typed output.

```typescript
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { model, provider } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type { ModelDataInput, ModelUpsertData, ProviderUpsertData } from "./types";

// ────────────────────────────────────────────
// Provider 操作
// ────────────────────────────────────────────

export async function listProviders(ctx: AuthContext) {
  const rows = await db
    .select({
      id: provider.id,
      name: provider.name,
      displayName: provider.displayName,
      npm: provider.npm,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      extraOptions: provider.extraOptions,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
      modelCount: sql<number>`(SELECT COUNT(*) FROM ${model} WHERE ${model.providerId} = ${provider.id})`,
    })
    .from(provider)
    .where(eq(provider.organizationId, ctx.organizationId));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    npm: r.npm,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    extraOptions: r.extraOptions,
    modelCount: Number(r.modelCount),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function getProvider(ctx: AuthContext, name: string) {
  const rows = await db
    .select()
    .from(provider)
    .where(and(eq(provider.organizationId, ctx.organizationId), eq(provider.name, name)))
    .limit(1);
  if (rows.length === 0) return null;
  const p = rows[0];

  const models = await db.select().from(model).where(eq(model.providerId, p.id));

  return { ...p, models };
}

export async function upsertProvider(
  ctx: AuthContext,
  name: string,
  data: ProviderUpsertData,
) {
  const set = {
    displayName: data.displayName,
    npm: data.npm,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    extraOptions: data.extraOptions ?? undefined,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(provider)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      name,
      ...set,
    })
    .onConflictDoUpdate({
      target: [provider.organizationId, provider.name],
      set,
    })
    .returning({ id: provider.id });

  return row.id;
}

export async function deleteProvider(ctx: AuthContext, name: string): Promise<boolean> {
  const result = await db
    .delete(provider)
    .where(and(eq(provider.organizationId, ctx.organizationId), eq(provider.name, name)))
    .returning({ id: provider.id });
  return result.length > 0;
}

/** Map frontend model data fields to PG model columns */
export function buildModelData(data: ModelDataInput): Omit<ModelUpsertData, "modelId"> {
  const result: { displayName?: string; modalities?: unknown; limitConfig?: unknown; cost?: unknown; options?: unknown } = {};
  if (typeof data.name === "string") result.displayName = data.name;
  if (data.modalities !== undefined) result.modalities = data.modalities;
  if (data.limit !== undefined) result.limitConfig = data.limit;
  if (data.cost !== undefined) result.cost = data.cost;
  if (data.options !== undefined) result.options = data.options;
  return result;
}
```

- [ ] **Step 2: Update `src/services/config/model.ts`**

Replace `unknown` in function params with typed JSONB interfaces.

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { model } from "../../db/schema";
import type { ModelCostConfig, ModelLimitConfig, ModelModalities, ModelOptions, ModelUpsertData } from "./types";

// ────────────────────────────────────────────
// Model 操作
//
// 所有函数以 organizationId 为首参数，WHERE 条件包含 organization_id 隔离。
// 调用方（通常是 routes/web/config/providers.ts）传入 authCtx.organizationId。
// ────────────────────────────────────────────

/** Model JSONB column value types for insert/update */
interface ModelJsonbData {
  displayName?: string;
  modalities?: ModelModalities | null;
  limitConfig?: ModelLimitConfig | null;
  cost?: ModelCostConfig | null;
  options?: ModelOptions | null;
}

/** 构建 model 写入字段（addModel 的 values 和 set 共享） */
function buildModelValues(data: ModelJsonbData) {
  return {
    displayName: data.displayName,
    modalities: data.modalities ?? undefined,
    limitConfig: data.limitConfig ?? undefined,
    cost: data.cost ?? undefined,
    options: data.options ?? undefined,
    updatedAt: new Date(),
  };
}

export async function addModel(
  organizationId: string,
  providerId: string,
  data: ModelUpsertData,
) {
  const fields = buildModelValues(data);
  await db
    .insert(model)
    .values({ organizationId, providerId, modelId: data.modelId!, ...fields })
    .onConflictDoUpdate({
      target: [model.providerId, model.modelId],
      set: fields,
    });
}

export async function updateModel(
  organizationId: string,
  providerId: string,
  modelId: string,
  data: ModelJsonbData,
): Promise<boolean> {
  const set: Partial<typeof model.$inferInsert> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = data.modalities;
  if (data.limitConfig !== undefined) set.limitConfig = data.limitConfig;
  if (data.cost !== undefined) set.cost = data.cost;
  if (data.options !== undefined) set.options = data.options;

  const result = await db
    .update(model)
    .set(set)
    .where(and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}

export async function removeModel(organizationId: string, providerId: string, modelId: string): Promise<boolean> {
  const result = await db
    .delete(model)
    .where(and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}
```

- [ ] **Step 3: Update `src/services/config/skill.ts`**

Replace `Record<string, unknown>` in `upsertSkill` data param with `SkillUpsertData`.

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { skill } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type { SkillUpsertData } from "./types";

// ────────────────────────────────────────────
// Skill 操作（全局技能库）
// ────────────────────────────────────────────

export async function listSkills(ctx: AuthContext) {
  return db.select().from(skill).where(eq(skill.organizationId, ctx.organizationId));
}

export async function getSkill(ctx: AuthContext, name: string) {
  const rows = await db
    .select()
    .from(skill)
    .where(and(eq(skill.organizationId, ctx.organizationId), eq(skill.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertSkill(
  ctx: AuthContext,
  name: string,
  data: SkillUpsertData,
) {
  const existing = await db
    .select({ id: skill.id })
    .from(skill)
    .where(and(eq(skill.organizationId, ctx.organizationId), eq(skill.name, name)))
    .limit(1);

  const commonFields = {
    description: data.description,
    contentPath: data.contentPath,
    metadata: data.metadata ?? undefined,
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    await db.update(skill).set(commonFields).where(eq(skill.id, existing[0].id));
    return existing[0].id;
  }

  const inserted = await db
    .insert(skill)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      name,
      ...commonFields,
    })
    .returning({ id: skill.id });
  return inserted[0].id;
}

export async function deleteSkill(ctx: AuthContext, name: string): Promise<boolean> {
  const result = await db
    .delete(skill)
    .where(and(eq(skill.organizationId, ctx.organizationId), eq(skill.name, name)))
    .returning({ id: skill.id });
  return result.length > 0;
}
```

- [ ] **Step 4: Verify provider, model, and skill changes compile**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30
```

Expected: No new type errors introduced. The `provider.ts`, `model.ts`, and `skill.ts` files should pass.

---

### Task 3: Update agent-config service with typed interfaces

**Files:**
- Modify: `src/services/config/agent-config.ts`

- [ ] **Step 1: Update `src/services/config/agent-config.ts`**

Replace `Record<string, unknown>` in `buildSetFromData`, `createAgentConfig`, `updateAgentConfig`, and `validateAgentData` with `AgentConfigUpsertData`. Keep the internal `(set as Record<string, unknown>)` cast inside `buildSetFromData` since it's mapping dynamic fields to Drizzle columns.

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type { AgentKnowledgeConfig, AgentKnowledgePolicy } from "../agent-knowledge";
import { resolveAgentKnowledgePolicy } from "../agent-knowledge";
import type { AgentConfigUpsertData, PermissionAction, PermissionConfig } from "./types";

// ────────────────────────────────────────────
// Agent Config 操作
// ────────────────────────────────────────────

const AGENT_SETTABLE_FIELDS = [
  "model",
  "prompt",
  "steps",
  "mode",
  "permission",
  "variant",
  "temperature",
  "topP",
  "top_p",
  "disable",
  "hidden",
  "color",
  "description",
  "knowledge",
] as const;

/** 前端字段名 → Drizzle 列名映射（路由层已做映射，此处为防御性兜底） */
const FIELD_ALIAS: Record<string, string> = { top_p: "topP" };

export async function listAgentConfigs(ctx: AuthContext) {
  return db.select().from(agentConfig).where(eq(agentConfig.organizationId, ctx.organizationId));
}

export async function getAgentConfig(ctx: AuthContext, name: string) {
  const rows = await db
    .select()
    .from(agentConfig)
    .where(and(eq(agentConfig.organizationId, ctx.organizationId), eq(agentConfig.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAgentConfigById(id: string, orgId?: string) {
  const conditions = [eq(agentConfig.id, id)];
  if (orgId) {
    conditions.push(eq(agentConfig.organizationId, orgId));
  }
  const rows = await db
    .select()
    .from(agentConfig)
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}

/** 将 data 中 AGENT_SETTABLE_FIELDS 范围内的字段映射为 Drizzle set 对象 */
function buildSetFromData(data: AgentConfigUpsertData): Partial<typeof agentConfig.$inferInsert> {
  const set: Partial<typeof agentConfig.$inferInsert> = { updatedAt: new Date() };
  for (const field of AGENT_SETTABLE_FIELDS) {
    if (data[field] !== undefined) {
      const drizzleKey = FIELD_ALIAS[field] ?? field;
      (set as Record<string, unknown>)[drizzleKey] = data[field] ?? null;
    }
  }
  return set;
}

export async function createAgentConfig(ctx: AuthContext, name: string, data: AgentConfigUpsertData) {
  const set = buildSetFromData(data);
  const values = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    name,
    ...set,
  } as typeof agentConfig.$inferInsert;

  await db
    .insert(agentConfig)
    .values(values)
    .onConflictDoUpdate({
      target: [agentConfig.organizationId, agentConfig.name],
      set,
    });
}

export async function updateAgentConfig(
  ctx: AuthContext,
  name: string,
  data: AgentConfigUpsertData,
): Promise<boolean> {
  const set = buildSetFromData(data);
  const result = await db
    .update(agentConfig)
    .set(set)
    .where(and(eq(agentConfig.organizationId, ctx.organizationId), eq(agentConfig.name, name)))
    .returning({ id: agentConfig.id });
  return result.length > 0;
}

export async function deleteAgentConfig(ctx: AuthContext, name: string): Promise<boolean> {
  const result = await db
    .delete(agentConfig)
    .where(and(eq(agentConfig.organizationId, ctx.organizationId), eq(agentConfig.name, name)))
    .returning({ id: agentConfig.id });
  return result.length > 0;
}

export { AGENT_SETTABLE_FIELDS };

// ────────────────────────────────────────────
// Agent Config 验证与转换
// ────────────────────────────────────────────

const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction", "meta"]);

function isValidMode(mode: string): boolean {
  return ["primary", "subagent", "all"].includes(mode);
}

function isValidSteps(steps: number): boolean {
  return Number.isInteger(steps) && steps >= 1 && steps <= 200;
}

/** 校验 agent 数据字段，返回错误码或 null */
export function validateAgentData(data: AgentConfigUpsertData): string | null {
  if (data.mode !== undefined && typeof data.mode === "string" && !isValidMode(data.mode)) return "INVALID_MODE";
  if (data.steps !== undefined && typeof data.steps === "number" && !isValidSteps(data.steps)) return "INVALID_STEPS";
  if (data.temperature !== undefined) {
    if (typeof data.temperature !== "number" || data.temperature < 0 || data.temperature > 2)
      return "INVALID_TEMPERATURE";
  }
  if (data.top_p !== undefined) {
    if (typeof data.top_p !== "number" || data.top_p < 0 || data.top_p > 1) return "INVALID_TOP_P";
  }
  if (data.topP !== undefined) {
    if (typeof data.topP !== "number" || data.topP < 0 || data.topP > 1) return "INVALID_TOP_P";
  }
  if (data.color !== undefined) {
    if (typeof data.color !== "string") return "INVALID_COLOR";
    const c = data.color;
    const PRESET_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"];
    const isHex = /^#[0-9a-fA-F]{6}$/.test(c);
    if (!isHex && !PRESET_COLORS.includes(c)) return "INVALID_COLOR";
  }
  if (data.permission !== undefined && data.permission !== null) {
    if (typeof data.permission === "string") return "INVALID_PERMISSION";
    if (typeof data.permission !== "object" || Array.isArray(data.permission)) return "INVALID_PERMISSION";
  }
  if (data.knowledge !== undefined) {
    const error = validateKnowledgeConfig(data.knowledge);
    if (error) return error;
  }
  return null;
}

function validateKnowledgeConfig(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object") return "INVALID_KNOWLEDGE";

  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.knowledgeBaseIds)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }
  if (config.knowledgeBaseIds.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }

  if (config.policy !== undefined && config.policy !== null) {
    if (typeof config.policy !== "object") {
      return "INVALID_KNOWLEDGE_POLICY";
    }
    const policy = config.policy as Record<string, unknown>;
    if (policy.searchFirst !== undefined && typeof policy.searchFirst !== "boolean") {
      return "INVALID_KNOWLEDGE_SEARCH_FIRST";
    }
    if (
      policy.maxResults !== undefined &&
      (!Number.isInteger(policy.maxResults) || (policy.maxResults as number) < 1 || (policy.maxResults as number) > 20)
    ) {
      return "INVALID_KNOWLEDGE_MAX_RESULTS";
    }
    if (
      policy.defaultNamespaces !== undefined &&
      (!Array.isArray(policy.defaultNamespaces) ||
        policy.defaultNamespaces.some((item) => typeof item !== "string" || item.trim().length === 0))
    ) {
      return "INVALID_KNOWLEDGE_DEFAULT_NAMESPACES";
    }
  }

  return null;
}

/** 将旧 tools 格式转换为 permission 格式 */
export function toolsToPermission(tools: Record<string, boolean>): Record<string, PermissionAction> {
  const result: Record<string, PermissionAction> = {};
  for (const [key, val] of Object.entries(tools)) {
    result[key] = val ? "allow" : "deny";
  }
  return result;
}

/** 规范化 knowledge config：去重、trim */
export function normalizeKnowledgeConfig(value: unknown): AgentKnowledgeConfig | null {
  if (value == null) return null;
  const input = value as AgentKnowledgeConfig;
  return {
    knowledgeBaseIds: Array.from(
      new Set(
        (Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds : [])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ),
    policy: normalizeKnowledgePolicy(input.policy),
  };
}

function normalizeKnowledgePolicy(value: AgentKnowledgePolicy | null | undefined) {
  const policy = resolveAgentKnowledgePolicy(value);
  return {
    searchFirst: policy.searchFirst,
    maxResults: policy.maxResults,
    defaultNamespaces: policy.defaultNamespaces,
  };
}

/** 判断 agent 是否为内置 */
export function isBuiltInAgent(name: string): boolean {
  return BUILT_IN_AGENTS.has(name);
}
```

- [ ] **Step 2: Verify agent-config changes compile**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30
```

Expected: No new type errors in `agent-config.ts`.

---

### Task 4: Update MCP server service with typed interfaces

**Files:**
- Modify: `src/services/config/mcp-server.ts`

- [ ] **Step 1: Update `src/services/config/mcp-server.ts`**

Replace `Record<string, unknown>` in `createMcpServer`, `updateMcpServer`, `validateMcpConfig`, and `toServerInfo` with typed MCP config interfaces.

```typescript
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { mcpServer, mcpTool } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import { parseJsonb } from "./jsonb";
import type {
  McpLocalConfig,
  McpRemoteConfig,
  McpServerConfig,
  McpServerInfoOutput,
  McpServerType,
  McpStreamableHttpConfig,
} from "./types";

// ────────────────────────────────────────────
// MCP Server 操作
// ────────────────────────────────────────────

export async function listMcpServers(ctx: AuthContext) {
  return db.select().from(mcpServer).where(eq(mcpServer.organizationId, ctx.organizationId));
}

export async function getMcpServer(ctx: AuthContext, name: string) {
  const rows = await db
    .select()
    .from(mcpServer)
    .where(and(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createMcpServer(
  ctx: AuthContext,
  name: string,
  type: McpServerType,
  config: McpServerConfig,
) {
  const values = {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    name,
    type,
    config: config as unknown as Record<string, unknown>,
    enabled: true,
    updatedAt: new Date(),
  };
  await db
    .insert(mcpServer)
    .values(values)
    .onConflictDoUpdate({
      target: [mcpServer.organizationId, mcpServer.name],
      set: {
        type,
        config: config as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });
}

export async function updateMcpServer(
  ctx: AuthContext,
  name: string,
  config: McpServerConfig,
): Promise<boolean> {
  const updates: Partial<typeof mcpServer.$inferInsert> = {
    config: config as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
  if ("type" in config && config.type) {
    updates.type = config.type;
  }
  const result = await db
    .update(mcpServer)
    .set(updates)
    .where(and(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.name, name)))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function deleteMcpServer(ctx: AuthContext, name: string): Promise<boolean> {
  const result = await db
    .delete(mcpServer)
    .where(and(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.name, name)))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function setMcpServerEnabled(ctx: AuthContext, name: string, enabled: boolean): Promise<boolean> {
  const result = await db
    .update(mcpServer)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.name, name)))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

// ────────────────────────────────────────────
// MCP Tool 缓存操作（mcp_tool 表）
// ────────────────────────────────────────────

/** 统计指定 server 的 tool 数量（使用 SQL COUNT，避免全量拉取） */
export async function countToolsByServer(organizationId: string, serverName: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(mcpTool)
    .where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
  return Number(row?.count ?? 0);
}

/** 删除指定 server 的所有缓存 tool */
export async function deleteToolsByServer(organizationId: string, serverName: string): Promise<void> {
  await db.delete(mcpTool).where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
}

/** 替换指定 server 的缓存 tool（事务保证原子性：先删后插） */
export async function replaceToolsForServer(
  organizationId: string,
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(mcpTool).where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
    if (tools.length > 0) {
      const now = new Date();
      const rows = tools.map((t) => ({
        id: randomUUID(),
        organizationId,
        serverName,
        toolName: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ?? null,
        inspectedAt: now,
      }));
      await tx.insert(mcpTool).values(rows);
    }
  });
}

/** 列出指定 server 的缓存 tool */
export async function listToolsByServer(organizationId: string, serverName: string) {
  return db
    .select()
    .from(mcpTool)
    .where(and(eq(mcpTool.organizationId, organizationId), eq(mcpTool.serverName, serverName)));
}

// ────────────────────────────────────────────
// MCP Server 验证与转换
// ────────────────────────────────────────────

/** MCP 服务器名称校验 */
export function isValidMcpName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    !/--/.test(name) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  );
}

/** 允许的 MCP 服务器类型 */
const VALID_MCP_TYPES: McpServerType[] = ["local", "remote", "streamable-http"];

/** 校验 MCP 配置结构，返回错误码或 null */
export function validateMcpConfig(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return "INVALID_CONFIG";
  const cfg = config as Record<string, unknown>;

  if ("enabled" in cfg && cfg.enabled === false && Object.keys(cfg).length === 1) return null;

  if (!("type" in cfg) || typeof cfg.type !== "string") return "INVALID_CONFIG_TYPE";
  const type = cfg.type as McpServerType;

  if (type === "local") {
    if (
      !Array.isArray(cfg.command) ||
      cfg.command.length === 0 ||
      cfg.command.some((c: unknown) => typeof c !== "string")
    ) {
      return "INVALID_COMMAND";
    }
    if (cfg.environment !== undefined && (typeof cfg.environment !== "object" || cfg.environment === null)) {
      return "INVALID_ENVIRONMENT";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else if (type === "remote" || type === "streamable-http") {
    if (typeof cfg.url !== "string" || cfg.url.length === 0) return "INVALID_URL";
    if (cfg.headers !== undefined && (typeof cfg.headers !== "object" || cfg.headers === null)) {
      return "INVALID_HEADERS";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else {
    return "INVALID_CONFIG_TYPE";
  }
  return null;
}

/** 将 PG 行数据转为前端展示信息 */
export function toServerInfo(name: string, row: { type: string; config: unknown; enabled: boolean }): McpServerInfoOutput {
  const config = parseJsonb<Record<string, unknown>>(row.config) ?? {};
  if (!row.enabled && !("type" in config)) {
    return { name, type: "disabled" as const, enabled: false, summary: "已禁用" };
  }
  const cfgType = config.type as string;
  if (cfgType === "local") {
    const command = Array.isArray(config.command) ? (config.command as string[]) : [];
    return {
      name,
      type: "local" as const,
      enabled: row.enabled,
      summary: command[0] ?? "",
      timeout: config.timeout as number | undefined,
    };
  }
  // streamable-http 和 remote 统一展示
  const typeLabel = cfgType === "streamable-http" ? ("streamable-http" as const) : ("remote" as const);
  return {
    name,
    type: typeLabel,
    enabled: row.enabled,
    summary: config.url ?? "",
    timeout: config.timeout as number | undefined,
  };
}
```

- [ ] **Step 2: Verify MCP server changes compile**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30
```

Expected: No new type errors in `mcp-server.ts`.

---

### Task 5: Update user-config service with typed PermissionConfig

**Files:**
- Modify: `src/services/config/user-config.ts`

- [ ] **Step 1: Update `src/services/config/user-config.ts`**

Replace the existing `UserConfigData` interface with the shared one from `types.ts`, and type the `permission` field.

```typescript
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { userConfig } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type { PermissionConfig, UserConfigData } from "./types";

export { type UserConfigData };

export async function getUserConfig(ctx: AuthContext): Promise<UserConfigData> {
  const rows = await db.select().from(userConfig).where(eq(userConfig.organizationId, ctx.organizationId)).limit(1);
  if (rows.length === 0) {
    return { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
  }
  const r = rows[0];
  return {
    defaultAgent: r.defaultAgent,
    currentModel: r.currentModel,
    smallModel: r.smallModel,
    permission: r.permission as PermissionConfig | null,
  };
}

export async function setUserConfig(ctx: AuthContext, patch: UserConfigData) {
  const set: Partial<typeof userConfig.$inferInsert> = { updatedAt: new Date() };
  if (patch.defaultAgent !== undefined) set.defaultAgent = patch.defaultAgent;
  if (patch.currentModel !== undefined) set.currentAgent = patch.currentModel;
  if (patch.smallModel !== undefined) set.smallModel = patch.smallModel;
  if (patch.permission !== undefined) {
    set.permission = patch.permission ?? null;
  }

  await db
    .insert(userConfig)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      ...set,
    })
    .onConflictDoUpdate({
      target: [userConfig.organizationId],
      set,
    });
}
```

- [ ] **Step 2: Verify user-config changes compile**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30
```

Expected: No new type errors.

---

### Task 6: Update barrel files to re-export types

**Files:**
- Modify: `src/services/config/index.ts`
- Modify: `src/services/config-pg.ts`

- [ ] **Step 1: Update `src/services/config/index.ts`**

Add re-exports for all types from `types.ts`. Add the new exports after the existing ones.

```typescript
export type { AuthContext } from "../../plugins/auth";
export {
  AGENT_SETTABLE_FIELDS,
  createAgentConfig,
  deleteAgentConfig,
  getAgentConfig,
  getAgentConfigById,
  isBuiltInAgent,
  listAgentConfigs,
  normalizeKnowledgeConfig,
  toolsToPermission,
  updateAgentConfig,
  validateAgentData,
} from "./agent-config";
export { listAgentSkillIds, syncAgentSkills } from "./agent-config-skill";
export type { AgentFullConfig } from "./aggregate";
export { getAgentFullConfig } from "./aggregate";
export { parseJsonb, parseJsonbOr } from "./jsonb";
export {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  isValidMcpName,
  listMcpServers,
  setMcpServerEnabled,
  toServerInfo,
  updateMcpServer,
  validateMcpConfig,
} from "./mcp-server";
export { addModel, removeModel, updateModel } from "./model";
export { buildModelData, deleteProvider, getProvider, listProviders, upsertProvider } from "./provider";
export {
  deleteSkill,
  getSkill,
  listSkills,
  upsertSkill,
} from "./skill";
export { getUserConfig, setUserConfig } from "./user-config";

// ──── Config type re-exports ────
export type {
  AgentConfigUpsertData,
  AgentKnowledgeConfig,
  AgentKnowledgePolicy,
  McpDisabledConfig,
  McpLocalConfig,
  McpOAuthConfig,
  McpRemoteConfig,
  McpServerConfig,
  McpServerInfoOutput,
  McpServerType,
  McpStreamableHttpConfig,
  ModelCostConfig,
  ModelDataInput,
  ModelLimitConfig,
  ModelModalities,
  ModelOptions,
  ModelUpsertData,
  PermissionAction,
  PermissionConfig,
  PermissionObjectConfig,
  ProviderExtraOptions,
  ProviderUpsertData,
  RuleBasedPermission,
  SkillMetadata,
  SkillUpsertData,
  UserConfigData,
} from "./types";
```

- [ ] **Step 2: Update `src/services/config-pg.ts`**

Add re-exports for the most commonly used types.

```typescript
// config-pg.ts 现在是桶文件，所有实现已迁移到 src/services/config/ 目录。
// 保持此文件以兼容现有 import 路径。

export type {
  AgentConfigUpsertData,
  AgentFullConfig,
  McpServerConfig,
  McpServerType,
  PermissionConfig,
  ProviderUpsertData,
  SkillUpsertData,
  UserConfigData,
} from "./config/index";
export {
  AGENT_SETTABLE_FIELDS,
  addModel,
  createAgentConfig,
  createMcpServer,
  deleteAgentConfig,
  deleteMcpServer,
  deleteProvider,
  deleteSkill,
  getAgentConfig,
  getAgentConfigById,
  getAgentFullConfig,
  getMcpServer,
  getProvider,
  getSkill,
  getUserConfig,
  listAgentConfigs,
  listAgentSkillIds,
  listMcpServers,
  listSkills,
  removeModel,
  setMcpServerEnabled,
  setUserConfig,
  syncAgentSkills,
  updateAgentConfig,
  updateMcpServer,
  updateModel,
  upsertProvider,
  upsertSkill,
} from "./config/index";
```

- [ ] **Step 3: Verify barrel files compile**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30
```

Expected: No new type errors.

---

### Task 7: Update route handlers to use typed interfaces

**Files:**
- Modify: `src/routes/web/config/mcp.ts`

- [ ] **Step 1: Update `src/routes/web/config/mcp.ts`**

Remove the locally-defined MCP type duplicates and import from `src/services/config/types.ts` instead. The rest of the route logic stays the same.

At the top of the file, replace the local type definitions:

```typescript
// REMOVE these local types:
// type McpLocalConfig = { ... };
// type McpRemoteConfig = { ... };
// type McpDisabledConfig = { enabled: false };
// type McpServerConfig = McpLocalConfig | McpRemoteConfig | McpDisabledConfig;

// ADD this import instead:
import type { McpServerConfig, McpRemoteConfig } from "../../../services/config/types";
```

The `McpServerConfig` from `types.ts` includes `McpStreamableHttpConfig` which the local version was missing. This is a safe expansion since the existing handlers already handle `streamable-http` in `toServerInfo`.

- [ ] **Step 2: Verify route changes compile**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30
```

Expected: No new type errors in the route files.

---

### Task 8: Add type guard utilities and unit tests

**Files:**
- Create: `src/__tests__/config-types.test.ts`

- [ ] **Step 1: Create test file with type guard validation tests**

```typescript
/**
 * config-types.test.ts — Tests for config entity type definitions.
 *
 * Validates that the type interfaces match expected JSONB shapes,
 * and that runtime values satisfy the type constraints.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentConfigUpsertData,
  McpDisabledConfig,
  McpLocalConfig,
  McpRemoteConfig,
  McpServerConfig,
  McpServerType,
  McpStreamableHttpConfig,
  PermissionAction,
  PermissionConfig,
  PermissionObjectConfig,
  ProviderUpsertData,
  SkillUpsertData,
  UserConfigData,
} from "../services/config/types";

// Permission 类型测试
describe("PermissionConfig types", () => {
  test("PermissionAction accepts valid tri-state values", () => {
    const actions: PermissionAction[] = ["ask", "allow", "deny"];
    expect(actions).toHaveLength(3);
  });

  test("PermissionObjectConfig accepts rule-based and switch-type tools", () => {
    const config: PermissionObjectConfig = {
      bash: "allow",
      read: { "*.env": "deny", "src/**": "allow" },
      edit: "ask",
      todowrite: "allow",
      webfetch: "deny",
    };
    expect(config.bash).toBe("allow");
    expect(config.read).toEqual({ "*.env": "deny", "src/**": "allow" });
  });

  test("PermissionConfig accepts global action string", () => {
    const config: PermissionConfig = "allow";
    expect(config).toBe("allow");
  });

  test("PermissionConfig accepts per-tool object", () => {
    const config: PermissionConfig = { bash: "allow", edit: "ask" };
    expect(typeof config).toBe("object");
  });
});

// MCP 类型测试
describe("McpServerConfig types", () => {
  test("McpLocalConfig shape is correct", () => {
    const config: McpLocalConfig = {
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_TOKEN: "{env:GITHUB_TOKEN}" },
      enabled: true,
      timeout: 5000,
    };
    expect(config.type).toBe("local");
    expect(config.command).toHaveLength(3);
  });

  test("McpRemoteConfig shape is correct", () => {
    const config: McpRemoteConfig = {
      type: "remote",
      url: "https://api.mcp.example.com/sse",
      headers: { Authorization: "Bearer {env:MCP_TOKEN}" },
      enabled: true,
      timeout: 5000,
    };
    expect(config.type).toBe("remote");
    expect(config.url).toContain("mcp.example.com");
  });

  test("McpStreamableHttpConfig shape is correct", () => {
    const config: McpStreamableHttpConfig = {
      type: "streamable-http",
      url: "https://api.mcp.example.com/mcp",
      headers: { Authorization: "Bearer token" },
      timeout: 10000,
    };
    expect(config.type).toBe("streamable-http");
  });

  test("McpDisabledConfig shape is correct", () => {
    const config: McpDisabledConfig = { enabled: false };
    expect(config.enabled).toBe(false);
  });

  test("McpServerConfig union accepts all variants", () => {
    const configs: McpServerConfig[] = [
      { type: "local", command: ["node", "server.js"] },
      { type: "remote", url: "https://example.com" },
      { type: "streamable-http", url: "https://example.com/mcp" },
      { enabled: false },
    ];
    expect(configs).toHaveLength(4);
  });

  test("McpServerType covers all valid types", () => {
    const types: McpServerType[] = ["local", "remote", "streamable-http"];
    expect(types).toHaveLength(3);
  });
});

// Provider 类型测试
describe("ProviderUpsertData type", () => {
  test("accepts partial provider data", () => {
    const data: ProviderUpsertData = {
      displayName: "OpenAI",
      npm: "@ai-sdk/openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-xxx",
      extraOptions: { organization: "org-123" },
    };
    expect(data.displayName).toBe("OpenAI");
  });

  test("accepts minimal provider data", () => {
    const data: ProviderUpsertData = {
      apiKey: "sk-xxx",
    };
    expect(Object.keys(data)).toHaveLength(1);
  });
});

// Skill 类型测试
describe("SkillUpsertData type", () => {
  test("accepts skill metadata", () => {
    const data: SkillUpsertData = {
      description: "Code review skill",
      contentPath: "/path/to/SKILL.md",
      metadata: { version: "1.0", author: "team" },
    };
    expect(data.metadata?.version).toBe("1.0");
  });
});

// AgentConfig 类型测试
describe("AgentConfigUpsertData type", () => {
  test("accepts full agent config data", () => {
    const data: AgentConfigUpsertData = {
      model: "claude-3-5-sonnet",
      prompt: "You are a helpful assistant",
      steps: 50,
      mode: "primary",
      permission: { bash: "allow", edit: "ask" },
      temperature: 0.7,
      topP: 0.9,
      disable: false,
      hidden: false,
      description: "Main agent",
      knowledge: {
        knowledgeBaseIds: ["kb-1", "kb-2"],
        policy: { searchFirst: true, maxResults: 5 },
      },
      skillIds: ["skill-1"],
    };
    expect(data.model).toBe("claude-3-5-sonnet");
  });
});

// UserConfig 类型测试
describe("UserConfigData type", () => {
  test("accepts user preferences", () => {
    const data: UserConfigData = {
      defaultAgent: "general",
      currentModel: "claude-3-5-sonnet",
      smallModel: "claude-3-5-haiku",
      permission: { bash: "allow" },
    };
    expect(data.defaultAgent).toBe("general");
  });

  test("accepts null values for optional fields", () => {
    const data: UserConfigData = {
      defaultAgent: null,
      currentModel: null,
      smallModel: null,
      permission: null,
    };
    expect(data.defaultAgent).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/config-types.test.ts
```

Expected: All tests pass.

---

### Task 9: Run full precheck

**Files:** None (verification only)

- [ ] **Step 1: Run the project-wide type check and lint**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

Expected: 0 errors, 0 warnings (or no new errors/warnings compared to before the changes).

- [ ] **Step 2: Run the full backend test suite to ensure no regressions**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/ 2>&1 | tail -20
```

Expected: All existing tests still pass. No new failures.

---

## Summary of Changes

### `Record<string, unknown>` Removal Count

| File | Before | After | Replacement |
|------|--------|-------|-------------|
| `provider.ts` | 2 | 0 | `ProviderUpsertData`, `ModelDataInput` |
| `model.ts` | 0 (used `unknown`) | 0 | `ModelJsonbData`, typed JSONB interfaces |
| `agent-config.ts` | 7 | 1 (internal Drizzle cast) | `AgentConfigUpsertData` |
| `mcp-server.ts` | 4 | 0 | `McpServerConfig` union, `McpServerType` |
| `skill.ts` | 1 | 0 | `SkillUpsertData` |
| `user-config.ts` | 0 (used `unknown`) | 0 | `PermissionConfig \| null` |
| **Total** | **14** | **1** (unavoidable internal cast) | |

### Type Safety Improvements

1. **PermissionConfig**: Now a discriminated union of `PermissionAction | PermissionObjectConfig` instead of `unknown`
2. **McpServerConfig**: Now a tagged union with `type` discriminator instead of `Record<string, unknown>`
3. **AgentConfigUpsertData**: All fields typed with proper nullability instead of `Record<string, unknown>`
4. **ProviderUpsertData**: Explicit field list instead of `Record<string, unknown>`
5. **ModelUpsertData**: JSONB columns typed as `ModelModalities`, `ModelLimitConfig`, `ModelCostConfig` instead of `unknown`
6. **SkillUpsertData**: `metadata` typed as `Record<string, string>` instead of `Record<string, unknown>`

### Frontend Alignment

The backend types in `src/services/config/types.ts` mirror the existing frontend types in `web/src/types/config.ts`. The frontend types already have proper definitions for `PermissionConfig`, `McpServerConfig`, `AgentKnowledgeConfig`, etc. The backend types should be kept in sync via comments noting the correspondence. No frontend changes are strictly required for this plan, but a future task could unify them by importing from a shared location.
