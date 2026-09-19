import { eq } from "drizzle-orm";
import { db } from "../../db";
import { userConfig } from "../../db/schema";
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

/**
 * 用户偏好的定位上下文：`user_config` 按组织一行存储，只需要组织与用户标识。
 *
 * 刻意不收 `AuthContext`：调用方既有宿主路由（持有 `AuthContext`）也有资源包协议层（只持有
 * `ActorContext`）。`AuthContext` 与本接口结构兼容，宿主调用点无需改动；两个平台的上下文类型则
 * 不必互相导入。
 */
export interface UserConfigSubject {
  readonly organizationId: string;
  readonly userId: string;
}

export async function getUserConfig(ctx: UserConfigSubject): Promise<UserConfigData> {
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

export async function setUserConfig(ctx: UserConfigSubject, patch: UserConfigData) {
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
