import { db } from "../../db";
import { agentConfig } from "../../db/schema";
import { eq, and } from "drizzle-orm";

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

export async function getAgentConfigById(id: string) {
  const rows = await db.select().from(agentConfig)
    .where(eq(agentConfig.id, id))
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

export { AGENT_SETTABLE_FIELDS };
