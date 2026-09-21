import { type NewSandboxPool, type SandboxPool, sandboxPool } from "@fenix/resource-sandbox/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { getSandboxDatabase } from "../db";

/**
 * Sandbox 资源池的唯一数据访问点。
 *
 * DB 句柄在函数内取（`getSandboxDatabase()`）：模块加载期宿主可能尚未完成基础设施初始化，
 * 在模块顶层固化句柄会让导入顺序变成隐式启动依赖。
 */

/** 资源池对当前组织是否可读：全局池（`organizationId = null`）对所有组织可见。 */
export function isSandboxPoolReadable(pool: Pick<SandboxPool, "organizationId">, organizationId: string): boolean {
  return pool.organizationId === null || pool.organizationId === organizationId;
}

export async function findSandboxPoolById(id: string): Promise<SandboxPool | null> {
  const [row] = await getSandboxDatabase().select().from(sandboxPool).where(eq(sandboxPool.id, id)).limit(1);
  return row ?? null;
}

export async function findReadableSandboxPoolById(id: string, organizationId: string): Promise<SandboxPool | null> {
  const [row] = await getSandboxDatabase()
    .select()
    .from(sandboxPool)
    .where(
      and(
        eq(sandboxPool.id, id),
        or(isNull(sandboxPool.organizationId), eq(sandboxPool.organizationId, organizationId)),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listReadableSandboxPools(organizationId: string): Promise<SandboxPool[]> {
  return getSandboxDatabase()
    .select()
    .from(sandboxPool)
    .where(or(isNull(sandboxPool.organizationId), eq(sandboxPool.organizationId, organizationId)));
}

export async function listSandboxPools(): Promise<SandboxPool[]> {
  return getSandboxDatabase().select().from(sandboxPool).orderBy(sandboxPool.createdAt);
}

export async function createSandboxPool(input: NewSandboxPool): Promise<SandboxPool> {
  const [row] = await getSandboxDatabase().insert(sandboxPool).values(input).returning();
  return row;
}

export async function updateSandboxPool(id: string, patch: Partial<NewSandboxPool>): Promise<SandboxPool | null> {
  const [row] = await getSandboxDatabase()
    .update(sandboxPool)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sandboxPool.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSandboxPool(id: string): Promise<SandboxPool | null> {
  const [row] = await getSandboxDatabase().delete(sandboxPool).where(eq(sandboxPool.id, id)).returning();
  return row ?? null;
}

/** 按主键插入或覆盖资源池；默认资源池启动引导依赖 `id` 稳定，不能用「先查后写」。 */
export async function upsertSandboxPool(input: NewSandboxPool): Promise<SandboxPool> {
  const [row] = await getSandboxDatabase()
    .insert(sandboxPool)
    .values(input)
    .onConflictDoUpdate({
      target: sandboxPool.id,
      set: {
        name: input.name,
        organizationId: input.organizationId,
        providerKey: input.providerKey,
        image: input.image,
        defaultResources: input.defaultResources,
        extra: input.extra,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export const sandboxPoolRepository = {
  findById: findSandboxPoolById,
  findReadableById: findReadableSandboxPoolById,
  listReadable: listReadableSandboxPools,
  list: listSandboxPools,
  create: createSandboxPool,
  update: updateSandboxPool,
  delete: deleteSandboxPool,
  upsert: upsertSandboxPool,
};
