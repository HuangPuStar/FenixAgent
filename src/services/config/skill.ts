import { db } from "../../db";
import { skill } from "../../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

// ────────────────────────────────────────────
// Skill 操作
// ────────────────────────────────────────────

export async function listSkills(userId: string, agentConfigId?: string | null) {
  if (agentConfigId) {
    // 返回全局 Skill + 指定 Agent 的专属 Skill
    return db.select().from(skill)
      .where(and(
        eq(skill.userId, userId),
        isNull(skill.environmentId),
        sql`(${skill.agentConfigId} IS NULL OR ${skill.agentConfigId} = ${agentConfigId})`,
      ));
  }
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
    agentConfigId?: string | null;
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
    agentConfigId: data.agentConfigId ?? null,
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
    agentConfigId: data.agentConfigId ?? null,
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
