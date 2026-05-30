import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type { AgentKnowledgeConfig, AgentKnowledgePolicy } from "../agent-knowledge";
import { resolveAgentKnowledgePolicy } from "../agent-knowledge";

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
  "machineId",
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
function buildSetFromData(data: Record<string, unknown>): Partial<typeof agentConfig.$inferInsert> {
  const set: Partial<typeof agentConfig.$inferInsert> = { updatedAt: new Date() };
  for (const field of AGENT_SETTABLE_FIELDS) {
    if (data[field] !== undefined) {
      const drizzleKey = FIELD_ALIAS[field] ?? field;
      (set as Record<string, unknown>)[drizzleKey] = data[field] ?? null;
    }
  }
  return set;
}

export async function createAgentConfig(ctx: AuthContext, name: string, data: Record<string, unknown>) {
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
  data: Record<string, unknown>,
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

type PermissionAction = "ask" | "allow" | "deny";

const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction", "meta"]);

function isValidMode(mode: string): boolean {
  return ["primary", "subagent", "all"].includes(mode);
}

function isValidSteps(steps: number): boolean {
  return Number.isInteger(steps) && steps >= 1 && steps <= 200;
}

/** 校验 agent 数据字段，返回错误码或 null */
export function validateAgentData(data: Record<string, unknown>): string | null {
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
