import { db } from "../db";
import { provider, model, agentConfig, mcpServer, skill, userConfig, mcpTool } from "../db/schema";
import { eq, and, isNull, isNotNull, sql } from "drizzle-orm";

// ────────────────────────────────────────────
// Provider 操作
// ────────────────────────────────────────────

export async function listProviders(userId: string) {
  const rows = await db.select({
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
    .where(eq(provider.userId, userId));

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

export async function getProvider(userId: string, name: string) {
  const rows = await db.select().from(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .limit(1);
  if (rows.length === 0) return null;
  const p = rows[0];

  const models = await db.select().from(model)
    .where(eq(model.providerId, p.id));

  return { ...p, models };
}

export async function upsertProvider(
  userId: string,
  name: string,
  data: {
    displayName?: string;
    npm?: string;
    baseUrl?: string;
    apiKey?: string;
    extraOptions?: Record<string, unknown>;
  },
) {
  const existing = await db.select({ id: provider.id }).from(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(provider)
      .set({
        displayName: data.displayName,
        npm: data.npm,
        baseUrl: data.baseUrl,
        apiKey: data.apiKey,
        extraOptions: data.extraOptions ? JSON.stringify(data.extraOptions) : undefined,
        updatedAt: new Date(),
      })
      .where(eq(provider.id, existing[0].id));
    return existing[0].id;
  }

  const inserted = await db.insert(provider).values({
    userId,
    name,
    displayName: data.displayName,
    npm: data.npm,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    extraOptions: data.extraOptions ? JSON.stringify(data.extraOptions) : undefined,
  }).returning({ id: provider.id });
  return inserted[0].id;
}

export async function deleteProvider(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .returning({ id: provider.id });
  return result.length > 0;
}

// ────────────────────────────────────────────
// Model 操作
// ────────────────────────────────────────────

export async function addModel(
  providerId: string,
  data: {
    modelId: string;
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
) {
  await db.insert(model).values({
    providerId,
    modelId: data.modelId,
    displayName: data.displayName,
    modalities: data.modalities ? JSON.stringify(data.modalities) : undefined,
    limitConfig: data.limitConfig ? JSON.stringify(data.limitConfig) : undefined,
    cost: data.cost ? JSON.stringify(data.cost) : undefined,
    options: data.options ? JSON.stringify(data.options) : undefined,
  });
}

export async function updateModel(
  providerId: string,
  modelId: string,
  data: {
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = JSON.stringify(data.modalities);
  if (data.limitConfig !== undefined) set.limitConfig = JSON.stringify(data.limitConfig);
  if (data.cost !== undefined) set.cost = JSON.stringify(data.cost);
  if (data.options !== undefined) set.options = JSON.stringify(data.options);

  await db.update(model).set(set)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)));
}

export async function removeModel(providerId: string, modelId: string): Promise<boolean> {
  const result = await db.delete(model)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}

// ────────────────────────────────────────────
// Agent Config 操作
// ────────────────────────────────────────────

const AGENT_SETTABLE_FIELDS = [
  "model", "prompt", "steps", "mode", "permission",
  "variant", "temperature", "topP", "disable", "hidden", "color", "description", "knowledge",
] as const;

export async function listAgentConfigs(userId: string) {
  return db.select().from(agentConfig)
    .where(eq(agentConfig.userId, userId));
}

export async function getAgentConfig(userId: string, name: string) {
  const rows = await db.select().from(agentConfig)
    .where(and(eq(agentConfig.userId, userId), eq(agentConfig.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAgentConfig(
  userId: string,
  name: string,
  data: Record<string, unknown>,
) {
  const values: Record<string, unknown> = { userId, name };
  for (const field of AGENT_SETTABLE_FIELDS) {
    if (data[field] !== undefined) {
      const val = data[field];
      if (field === "permission" || field === "knowledge") {
        values[field] = val != null ? JSON.stringify(val) : null;
      } else {
        values[field] = val;
      }
    }
  }
  await db.insert(agentConfig).values(values as typeof agentConfig.$inferInsert);
}

export async function updateAgentConfig(
  userId: string,
  name: string,
  data: Record<string, unknown>,
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const field of AGENT_SETTABLE_FIELDS) {
    if (data[field] !== undefined) {
      const val = data[field];
      if (field === "permission" || field === "knowledge") {
        set[field] = val != null ? JSON.stringify(val) : null;
      } else {
        set[field] = val;
      }
    }
  }
  await db.update(agentConfig).set(set)
    .where(and(eq(agentConfig.userId, userId), eq(agentConfig.name, name)));
}

export async function deleteAgentConfig(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(agentConfig)
    .where(and(eq(agentConfig.userId, userId), eq(agentConfig.name, name)))
    .returning({ id: agentConfig.id });
  return result.length > 0;
}

// ────────────────────────────────────────────
// MCP Server 操作
// ────────────────────────────────────────────

export async function listMcpServers(userId: string) {
  return db.select().from(mcpServer)
    .where(eq(mcpServer.userId, userId));
}

export async function getMcpServer(userId: string, name: string) {
  const rows = await db.select().from(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createMcpServer(
  userId: string,
  name: string,
  type: string,
  config: Record<string, unknown>,
) {
  await db.insert(mcpServer).values({
    userId,
    name,
    type,
    config: JSON.stringify(config),
  });
}

export async function updateMcpServer(
  userId: string,
  name: string,
  config: Record<string, unknown>,
) {
  await db.update(mcpServer)
    .set({ config: JSON.stringify(config), updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}

export async function deleteMcpServer(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function setMcpServerEnabled(userId: string, name: string, enabled: boolean) {
  await db.update(mcpServer)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}

// ────────────────────────────────────────────
// Skill 操作
// ────────────────────────────────────────────

export async function listSkills(userId: string) {
  return db.select().from(skill)
    .where(and(eq(skill.userId, userId), isNull(skill.environmentId)));
}

export async function listWorkspaceSkills(userId: string, environmentId: string) {
  return db.select().from(skill)
    .where(and(eq(skill.userId, userId), eq(skill.environmentId, environmentId)));
}

export async function getSkill(userId: string, name: string, environmentId?: string | null) {
  const conditions = environmentId
    ? and(eq(skill.userId, userId), eq(skill.name, name), eq(skill.environmentId, environmentId))
    : and(eq(skill.userId, userId), eq(skill.name, name), isNull(skill.environmentId));

  const rows = await db.select().from(skill)
    .where(conditions)
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertSkill(
  userId: string,
  name: string,
  data: {
    description?: string;
    contentPath?: string;
    metadata?: Record<string, unknown>;
    enabled?: boolean;
    environmentId?: string | null;
  },
) {
  const envId = data.environmentId ?? null;
  const conditions = envId
    ? and(eq(skill.userId, userId), eq(skill.name, name), eq(skill.environmentId, envId))
    : and(eq(skill.userId, userId), eq(skill.name, name), isNull(skill.environmentId));

  const existing = await db.select({ id: skill.id }).from(skill)
    .where(conditions)
    .limit(1);

  const values = {
    description: data.description,
    contentPath: data.contentPath,
    metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
    enabled: data.enabled,
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    await db.update(skill).set(values)
      .where(eq(skill.id, existing[0].id));
    return existing[0].id;
  }

  const inserted = await db.insert(skill).values({
    userId,
    environmentId: envId,
    name,
    description: data.description,
    contentPath: data.contentPath,
    metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
    enabled: data.enabled ?? true,
  }).returning({ id: skill.id });
  return inserted[0].id;
}

export async function deleteSkill(
  userId: string,
  name: string,
  environmentId?: string | null,
): Promise<boolean> {
  const conditions = environmentId
    ? and(eq(skill.userId, userId), eq(skill.name, name), eq(skill.environmentId, environmentId))
    : and(eq(skill.userId, userId), eq(skill.name, name), isNull(skill.environmentId));

  const result = await db.delete(skill).where(conditions).returning({ id: skill.id });
  return result.length > 0;
}

export async function enableSkill(userId: string, name: string): Promise<boolean> {
  const result = await db.update(skill)
    .set({ enabled: true, updatedAt: new Date() })
    .where(and(eq(skill.userId, userId), eq(skill.name, name)))
    .returning({ id: skill.id });
  return result.length > 0;
}

export async function disableSkill(userId: string, name: string): Promise<boolean> {
  const result = await db.update(skill)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(skill.userId, userId), eq(skill.name, name)))
    .returning({ id: skill.id });
  return result.length > 0;
}

// ────────────────────────────────────────────
// UserConfig 操作
// ────────────────────────────────────────────

interface UserConfigData {
  defaultAgent?: string | null;
  currentModel?: string | null;
  smallModel?: string | null;
  permission?: unknown;
}

export async function getUserConfig(userId: string): Promise<UserConfigData> {
  const rows = await db.select().from(userConfig)
    .where(eq(userConfig.userId, userId))
    .limit(1);
  if (rows.length === 0) {
    return { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
  }
  const r = rows[0];
  return {
    defaultAgent: r.defaultAgent,
    currentModel: r.currentModel,
    smallModel: r.smallModel,
    permission: r.permission,
  };
}

export async function setUserConfig(userId: string, patch: UserConfigData) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.defaultAgent !== undefined) values.defaultAgent = patch.defaultAgent;
  if (patch.currentModel !== undefined) values.currentModel = patch.currentModel;
  if (patch.smallModel !== undefined) values.smallModel = patch.smallModel;
  if (patch.permission !== undefined) {
    values.permission = patch.permission != null ? JSON.stringify(patch.permission) : null;
  }

  const existing = await db.select({ userId: userConfig.userId }).from(userConfig)
    .where(eq(userConfig.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userConfig).set(values)
      .where(eq(userConfig.userId, userId));
  } else {
    await db.insert(userConfig).values({
      userId,
      ...values,
    } as typeof userConfig.$inferInsert);
  }
}
