import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig, model, provider } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type { AgentKnowledgeConfig, AgentKnowledgePolicy } from "../agent-knowledge";
import { resolveAgentKnowledgePolicy } from "../agent-knowledge";
import {
  assertInternalWritable,
  canReadResource,
  decorateResourceAccess,
  listReadableResourceRefs,
  setPublicRead,
} from "../resource-permission";
import type { AgentConfigDetailWithAccess, AgentConfigRowWithAccess } from "./types";

// ────────────────────────────────────────────
// Agent Config 操作
// ────────────────────────────────────────────

const AGENT_SETTABLE_FIELDS = ["modelId", "prompt", "description", "extra", "machineId", "knowledge"] as const;

type AgentConfigRow = typeof agentConfig.$inferSelect;
type AgentConfigSetOptions = { publicReadable?: boolean };

function parseResourceKey(resourceKey: string) {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    sourceOrganizationId: resourceKey.slice(0, slashIndex),
    resourceUid: resourceKey.slice(slashIndex + 1),
  };
}

/**
 * Hydrates agent rows with derived model refs so callers can keep the old response contract.
 */
async function hydrateAgentConfigRows(rows: AgentConfigRow[]): Promise<AgentConfigRow[]> {
  const modelIds = Array.from(
    new Set(rows.map((row) => row.modelId).filter((value): value is string => Boolean(value))),
  );
  if (modelIds.length === 0) return rows.map((row) => ({ ...row, model: null }));

  const modelRows = await db
    .select({
      id: model.id,
      modelName: model.modelId,
      providerId: model.providerId,
    })
    .from(model)
    .where(inArray(model.id, modelIds));
  const providerIds = Array.from(new Set(modelRows.map((row) => row.providerId)));
  const providerRows =
    providerIds.length > 0 ? await db.select().from(provider).where(inArray(provider.id, providerIds)) : [];
  const providerMap = new Map(providerRows.map((row) => [row.id, row]));
  const modelMap = new Map(modelRows.map((row) => [row.id, row]));

  return rows.map((row) => ({
    ...row,
    model: (() => {
      if (!row.modelId) return null;
      const modelRow = modelMap.get(row.modelId);
      const providerRow = modelRow ? providerMap.get(modelRow.providerId) : null;
      if (!modelRow || !providerRow) return null;
      return providerRow.organizationId === row.organizationId
        ? `${providerRow.name}/${modelRow.modelName}`
        : `${providerRow.organizationId}/${providerRow.id}/${modelRow.modelName}`;
    })(),
  }));
}

async function listExternalAgentConfigs(ctx: AuthContext): Promise<AgentConfigRow[]> {
  const refs = await listReadableResourceRefs(ctx, "agent_config");
  const ids = refs.map((ref) => ref.resourceId);
  if (ids.length === 0) return [];

  const rows = await db.select().from(agentConfig).where(inArray(agentConfig.id, ids));
  const refKeys = new Set(refs.map((ref) => `${ref.organizationId}/${ref.resourceId}`));
  return rows.filter((row) => refKeys.has(`${row.organizationId}/${row.id}`));
}

export async function listAgentConfigs(ctx: AuthContext): Promise<AgentConfigRowWithAccess[]> {
  const internal = await db.select().from(agentConfig).where(eq(agentConfig.organizationId, ctx.organizationId));
  const external = await listExternalAgentConfigs(ctx);
  const hydratedRows = await hydrateAgentConfigRows([...internal, ...external]);
  return (await decorateResourceAccess(ctx, "agent_config", hydratedRows)) as unknown as AgentConfigRowWithAccess[];
}

export async function getAgentConfigByResourceKey(
  ctx: AuthContext,
  resourceKey: string,
): Promise<AgentConfigDetailWithAccess | null> {
  const parsed = parseResourceKey(resourceKey);
  if (!parsed) return null;

  const rows = await db.select().from(agentConfig).where(eq(agentConfig.id, parsed.resourceUid)).limit(1);
  const row = rows[0] ?? null;
  if (!row || row.organizationId !== parsed.sourceOrganizationId) return null;

  const readable = await canReadResource(ctx, "agent_config", row.id, row.organizationId);
  if (!readable) return null;

  const [hydratedRow] = await hydrateAgentConfigRows([row]);
  const [decorated] = await decorateResourceAccess(ctx, "agent_config", [hydratedRow]);
  return decorated as unknown as AgentConfigDetailWithAccess;
}

export async function getAgentConfig(
  ctx: AuthContext,
  nameOrResourceKey: string,
): Promise<AgentConfigDetailWithAccess | null> {
  if (parseResourceKey(nameOrResourceKey)) {
    return getAgentConfigByResourceKey(ctx, nameOrResourceKey);
  }

  const rows = await db
    .select()
    .from(agentConfig)
    .where(and(eq(agentConfig.organizationId, ctx.organizationId), eq(agentConfig.name, nameOrResourceKey)))
    .limit(1);
  const internal = rows[0] ?? null;
  if (internal) {
    const [hydratedRow] = await hydrateAgentConfigRows([internal]);
    const [decorated] = await decorateResourceAccess(ctx, "agent_config", [hydratedRow]);
    return decorated as unknown as AgentConfigDetailWithAccess;
  }

  const external = (await listExternalAgentConfigs(ctx)).find((row) => row.name === nameOrResourceKey);
  if (!external) return null;

  const readable = await canReadResource(ctx, "agent_config", external.id, external.organizationId);
  if (!readable) return null;

  const [hydratedRow] = await hydrateAgentConfigRows([external]);
  const [decorated] = await decorateResourceAccess(ctx, "agent_config", [hydratedRow]);
  return decorated as unknown as AgentConfigDetailWithAccess;
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
  const row = rows[0] ?? null;
  if (!row) {
    return null;
  }
  const [hydratedRow] = await hydrateAgentConfigRows([row]);
  return hydratedRow;
}

export async function getReadableAgentConfigById(
  ctx: AuthContext,
  id: string,
): Promise<AgentConfigDetailWithAccess | null> {
  const row = await getAgentConfigById(id);
  if (!row) return null;

  if (row.organizationId !== ctx.organizationId) {
    const readable = await canReadResource(ctx, "agent_config", row.id, row.organizationId);
    if (!readable) return null;
  }

  const [decorated] = await decorateResourceAccess(ctx, "agent_config", [row]);
  return decorated as unknown as AgentConfigDetailWithAccess;
}

/** 将 data 中 AGENT_SETTABLE_FIELDS 范围内的字段映射为 Drizzle set 对象。 */
async function buildSetFromData(data: Record<string, unknown>): Promise<Partial<typeof agentConfig.$inferInsert>> {
  const set: Partial<typeof agentConfig.$inferInsert> = { updatedAt: new Date() };
  for (const field of AGENT_SETTABLE_FIELDS) {
    if (data[field] === undefined) continue;
    if (field === "knowledge") continue;
    if (field === "modelId") {
      set.modelId = typeof data.modelId === "string" && data.modelId.trim().length > 0 ? data.modelId : null;
      // model 只保留给启动迁移读取；新写入统一清空，避免双写再次漂移。
      set.model = null;
      continue;
    }

    (set as Record<string, unknown>)[field] = data[field] ?? null;
  }
  return set;
}

export async function createAgentConfig(
  ctx: AuthContext,
  name: string,
  data: Record<string, unknown>,
  options: AgentConfigSetOptions = {},
) {
  const set = await buildSetFromData(data);
  const [row] = await db
    .insert(agentConfig)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      name,
      ...set,
    } as typeof agentConfig.$inferInsert)
    .onConflictDoUpdate({
      target: [agentConfig.organizationId, agentConfig.name],
      set,
    })
    .returning({ id: agentConfig.id });

  if (options.publicReadable !== undefined) {
    await setPublicRead(ctx, "agent_config", ctx.organizationId, row.id, options.publicReadable);
  }

  return row.id;
}

export async function updateAgentConfig(
  ctx: AuthContext,
  nameOrResourceKey: string,
  data: Record<string, unknown>,
  options: AgentConfigSetOptions = {},
): Promise<boolean> {
  const existing = await getAgentConfig(ctx, nameOrResourceKey);
  if (!existing) return false;

  assertInternalWritable(ctx, "agent_config", existing.id, existing.organizationId);
  const set = await buildSetFromData(data);
  const result = await db
    .update(agentConfig)
    .set(set)
    .where(eq(agentConfig.id, existing.id))
    .returning({ id: agentConfig.id });
  if (result.length > 0 && options.publicReadable !== undefined) {
    await setPublicRead(ctx, "agent_config", ctx.organizationId, existing.id, options.publicReadable);
  }
  return result.length > 0;
}

export async function deleteAgentConfig(ctx: AuthContext, name: string): Promise<boolean> {
  const row = await getAgentConfig(ctx, name);
  if (!row) return false;

  assertInternalWritable(ctx, "agent_config", row.id, row.organizationId);
  const result = await db.delete(agentConfig).where(eq(agentConfig.id, row.id)).returning({ id: agentConfig.id });
  return result.length > 0;
}

export async function assertAgentConfigInternalWritable(
  ctx: AuthContext,
  nameOrResourceKey: string,
): Promise<AgentConfigDetailWithAccess | null> {
  const row = parseResourceKey(nameOrResourceKey)
    ? await getAgentConfigByResourceKey(ctx, nameOrResourceKey)
    : await getAgentConfig(ctx, nameOrResourceKey);
  if (!row) return null;
  assertInternalWritable(ctx, "agent_config", row.id, row.organizationId);
  return row;
}

export { AGENT_SETTABLE_FIELDS };

// ────────────────────────────────────────────
// Agent Config 验证与转换
// ────────────────────────────────────────────

const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction", "meta"]);

/** 校验 agent 数据字段，返回错误码或 null */
export function validateAgentData(data: Record<string, unknown>): string | null {
  if (data.extra !== undefined && data.extra !== null) {
    if (typeof data.extra !== "object" || Array.isArray(data.extra)) return "INVALID_EXTRA";
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
