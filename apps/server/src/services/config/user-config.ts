import { eq } from "drizzle-orm";
import { db } from "../../db";
import { userConfig } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type { PermissionConfig } from "./types";

// ────────────────────────────────────────────
// UserConfig 操作
// ────────────────────────────────────────────

export interface UserConfigData {
  defaultAgent?: string | null;
  currentModel?: string | null;
  smallModel?: string | null;
  permission?: PermissionConfig | null;
}

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
  if (patch.currentModel !== undefined) set.currentModel = patch.currentModel;
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
