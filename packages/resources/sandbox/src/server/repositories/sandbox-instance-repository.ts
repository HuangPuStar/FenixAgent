import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../../../../../apps/server/src/db";
import {
  type NewSandboxInstance,
  type SandboxInstance,
  sandboxInstance,
} from "../../../../../../apps/server/src/db/schema";

export type SandboxInstancePatch = Partial<
  Pick<
    NewSandboxInstance,
    "externalSandboxId" | "resolvedConfig" | "resourceOverrides" | "providerPayload" | "lastHeartbeatAt"
  >
>;

export type SandboxInstanceLockScope = {
  findById(id: string): Promise<SandboxInstance | null>;
  update(id: string, status: string, patch?: SandboxInstancePatch): Promise<SandboxInstance | null>;
  delete(id: string): Promise<SandboxInstance | null>;
};

export async function findActiveSandboxInstance(
  providerKey: string,
  poolId: string,
  userId: string,
): Promise<SandboxInstance | null> {
  const [row] = await db
    .select()
    .from(sandboxInstance)
    .where(
      and(
        eq(sandboxInstance.providerKey, providerKey),
        eq(sandboxInstance.sandboxPoolId, poolId),
        eq(sandboxInstance.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findSandboxInstanceByIdForUser(id: string, userId: string): Promise<SandboxInstance | null> {
  const [row] = await db
    .select()
    .from(sandboxInstance)
    .where(and(eq(sandboxInstance.id, id), eq(sandboxInstance.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function findSandboxInstanceById(id: string): Promise<SandboxInstance | null> {
  const [row] = await db.select().from(sandboxInstance).where(eq(sandboxInstance.id, id)).limit(1);
  return row ?? null;
}

/**
 * 在同一事务内锁定 sandbox_instance，并将锁内读写绑定到该事务。
 *
 * 这是 Sandbox provider 创建的持久化 single-flight 边界：锁必须从 provider
 * 查询/创建前一直保持到 externalSandboxId 回写完成。scope 内的 update/delete
 * 也必须使用 tx，否则会在当前事务持锁期间走另一条连接，既可能死锁，也无法
 * 保证第二个请求读取到第一个请求刚写入的资源 ID。
 */
export async function withSandboxInstanceLock<T>(
  id: string,
  operation: (scope: SandboxInstanceLockScope) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(sandboxInstance).where(eq(sandboxInstance.id, id)).for("update").limit(1);
    if (!locked) throw new Error(`sandbox instance '${id}' not found`);

    const scope: SandboxInstanceLockScope = {
      findById: async (lookupId) => {
        const [row] = await tx.select().from(sandboxInstance).where(eq(sandboxInstance.id, lookupId)).limit(1);
        return row ?? null;
      },
      update: async (updateId, status, patch = {}) => {
        const [row] = await tx
          .update(sandboxInstance)
          .set({ ...patch, status, updatedAt: new Date() })
          .where(eq(sandboxInstance.id, updateId))
          .returning();
        return row ?? null;
      },
      delete: async (deleteId) => {
        const [row] = await tx.delete(sandboxInstance).where(eq(sandboxInstance.id, deleteId)).returning();
        return row ?? null;
      },
    };

    return operation(scope);
  });
}

export async function findSandboxInstanceByMachineId(machineId: string): Promise<SandboxInstance | null> {
  const [row] = await db.select().from(sandboxInstance).where(eq(sandboxInstance.machineId, machineId)).limit(1);
  return row ?? null;
}

export async function createSandboxInstance(input: NewSandboxInstance): Promise<SandboxInstance> {
  const [row] = await db.insert(sandboxInstance).values(input).returning();
  return row;
}

export async function updateSandboxInstance(
  id: string,
  status: string,
  patch: SandboxInstancePatch = {},
): Promise<SandboxInstance | null> {
  const [row] = await db
    .update(sandboxInstance)
    .set({ ...patch, status, updatedAt: new Date() })
    .where(eq(sandboxInstance.id, id))
    .returning();
  return row ?? null;
}

export async function touchSandboxInstanceHeartbeat(id: string, at = new Date()): Promise<void> {
  await db.update(sandboxInstance).set({ lastHeartbeatAt: at, updatedAt: at }).where(eq(sandboxInstance.id, id));
}

export type SandboxInstanceListFilters = {
  sandboxPoolId?: string;
  instanceIds?: string[];
  userIds?: string[];
  providerKey?: string;
  statuses?: string[];
};

export async function listSandboxInstances(filters: SandboxInstanceListFilters = {}): Promise<SandboxInstance[]> {
  const conditions = [];
  if (filters.sandboxPoolId) conditions.push(eq(sandboxInstance.sandboxPoolId, filters.sandboxPoolId));
  if (filters.instanceIds?.length) conditions.push(inArray(sandboxInstance.id, filters.instanceIds));
  if (filters.userIds?.length) conditions.push(inArray(sandboxInstance.userId, filters.userIds));
  if (filters.providerKey) conditions.push(eq(sandboxInstance.providerKey, filters.providerKey));
  if (filters.statuses?.length) conditions.push(inArray(sandboxInstance.status, filters.statuses));
  return db
    .select()
    .from(sandboxInstance)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sandboxInstance.createdAt));
}

export async function deleteSandboxInstance(id: string): Promise<SandboxInstance | null> {
  const [row] = await db.delete(sandboxInstance).where(eq(sandboxInstance.id, id)).returning();
  return row ?? null;
}
