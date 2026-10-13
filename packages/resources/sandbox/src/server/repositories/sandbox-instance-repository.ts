import { type NewSandboxInstance, type SandboxInstance, sandboxInstance } from "@fenix/resource-sandbox/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getSandboxDatabase } from "../db";

/**
 * Sandbox 实例的唯一数据访问点。
 *
 * DB 句柄在函数内取（`getSandboxDatabase()`）：模块加载期宿主可能尚未完成基础设施初始化。
 */

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
  const [row] = await getSandboxDatabase()
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
  const [row] = await getSandboxDatabase()
    .select()
    .from(sandboxInstance)
    .where(and(eq(sandboxInstance.id, id), eq(sandboxInstance.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function findSandboxInstanceById(id: string): Promise<SandboxInstance | null> {
  const [row] = await getSandboxDatabase().select().from(sandboxInstance).where(eq(sandboxInstance.id, id)).limit(1);
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
  return getSandboxDatabase().transaction(async (tx) => {
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
  const [row] = await getSandboxDatabase()
    .select()
    .from(sandboxInstance)
    .where(eq(sandboxInstance.machineId, machineId))
    .limit(1);
  return row ?? null;
}

export async function createSandboxInstance(input: NewSandboxInstance): Promise<SandboxInstance> {
  const [row] = await getSandboxDatabase().insert(sandboxInstance).values(input).returning();
  return row;
}

export async function updateSandboxInstance(
  id: string,
  status: string,
  patch: SandboxInstancePatch = {},
): Promise<SandboxInstance | null> {
  const [row] = await getSandboxDatabase()
    .update(sandboxInstance)
    .set({ ...patch, status, updatedAt: new Date() })
    .where(eq(sandboxInstance.id, id))
    .returning();
  return row ?? null;
}

export async function touchSandboxInstanceHeartbeat(id: string, at = new Date()): Promise<void> {
  await getSandboxDatabase()
    .update(sandboxInstance)
    .set({ lastHeartbeatAt: at, updatedAt: at })
    .where(eq(sandboxInstance.id, id));
}

/**
 * 机器注册后把该机器上仍处于**中间态**的实例提升为 `ready`。
 *
 * 与 `updateSandboxInstance` 并列的第二条写入路径：机器侧事件只知道 `machineId`、不知道实例 ID，且一次
 * 通知可能命中该机器上的多个实例，因此按归属列批量更新。**终态不得被复活**——`destroyed` / `error` 等
 * 状态不在提升集合内，机器重连不会把已销毁的实例改回可用。
 */
export async function markSandboxInstancesReadyForMachine(machineId: string, at: Date): Promise<void> {
  await getSandboxDatabase()
    .update(sandboxInstance)
    .set({ status: "ready", lastHeartbeatAt: at, updatedAt: at })
    .where(
      and(
        eq(sandboxInstance.machineId, machineId),
        inArray(sandboxInstance.status, ["creating", "starting", "recovering"]),
      ),
    );
}

/** 机器心跳：只更新该机器上实例的活跃时间，不改状态（状态由实例自己的生命周期推进）。 */
export async function touchSandboxInstancesHeartbeatByMachine(machineId: string, at: Date): Promise<void> {
  await getSandboxDatabase()
    .update(sandboxInstance)
    .set({ lastHeartbeatAt: at, updatedAt: at })
    .where(eq(sandboxInstance.machineId, machineId));
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
  return getSandboxDatabase()
    .select()
    .from(sandboxInstance)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(sandboxInstance.createdAt));
}

export async function deleteSandboxInstance(id: string): Promise<SandboxInstance | null> {
  const [row] = await getSandboxDatabase().delete(sandboxInstance).where(eq(sandboxInstance.id, id)).returning();
  return row ?? null;
}
