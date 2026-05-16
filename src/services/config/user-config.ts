import { db } from "../../db";
import { userConfig } from "../../db/schema";
import { eq } from "drizzle-orm";

// ────────────────────────────────────────────
// UserConfig 操作
// ────────────────────────────────────────────

export interface UserConfigData {
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
  const values: Partial<typeof userConfig.$inferInsert> = { updatedAt: new Date() };
  if (patch.defaultAgent !== undefined) values.defaultAgent = patch.defaultAgent;
  if (patch.currentModel !== undefined) values.currentModel = patch.currentModel;
  if (patch.smallModel !== undefined) values.smallModel = patch.smallModel;
  if (patch.permission !== undefined) {
    values.permission = patch.permission ?? null;
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
    });
  }
}
