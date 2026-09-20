import { eq } from "drizzle-orm";
import { userConfig } from "../../db/schema";
import { getIdentityDatabase } from "../db";

/**
 * 用户偏好（`user_config` 表）的读写。
 *
 * 迁移自宿主 `apps/server/src/services/config/user-config.ts`（CE 阶段 2 任务 1.5c）：该表的真相来源
 * 本就在 `packages/platform/identity/db/schema.ts`，读写却留在宿主，属「表与它的读写分处两层」；迁入后
 * 两者同址，宿主不再持有身份族的持久化实现。除 DB 句柄改为 `getIdentityDatabase()` 外，SQL 与语义
 * （含 `undefined` = 不改这一项、`null` = 清空的补丁语义）原样保留。
 *
 * `permission` 按 jsonb 原样透传（`unknown`）：持久层不对它做结构校验，它的模型在宿主权限栈一侧声明，
 * 收进本包会让身份包跟着宿主的领域模型一起演进。
 *
 * 本文件不导出给包外：资源模块读写偏好只能经宿主的注入端口（`apps/server/src/services/resource-module-ports.ts`），
 * 宿主是本入口的唯一合法消费者。
 *
 * DB 句柄只能在函数内取用：`getIdentityDatabase()` 依赖宿主完成应用基础设施初始化，模块加载期读取会
 * 早于宿主装配。
 */

export interface UserConfigData {
  defaultAgent?: string | null;
  currentModel?: string | null;
  smallModel?: string | null;
  permission?: unknown;
}

/**
 * 用户偏好的定位上下文：`user_config` 按组织一行存储，只需要组织与用户标识。
 *
 * 刻意不收调用方的认证上下文对象：调用方既有宿主路由（持有 `AuthContext`）也有资源包协议层（只持有
 * `ActorContext`）。两种上下文与本接口结构兼容，写入方无需改动；两个平台的上下文类型则不必互相导入。
 */
export interface UserConfigSubject {
  readonly organizationId: string;
  readonly userId: string;
}

export async function getUserConfig(ctx: UserConfigSubject): Promise<UserConfigData> {
  const db = getIdentityDatabase();
  const rows = await db.select().from(userConfig).where(eq(userConfig.organizationId, ctx.organizationId)).limit(1);
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

export async function setUserConfig(ctx: UserConfigSubject, patch: UserConfigData) {
  const db = getIdentityDatabase();
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
