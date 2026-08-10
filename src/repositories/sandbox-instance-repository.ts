import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { type NewSandboxInstance, type SandboxInstance, sandboxInstance } from "../db/schema";

export type SandboxInstancePatch = Partial<
  Pick<
    NewSandboxInstance,
    "externalSandboxId" | "resolvedConfig" | "resourceOverrides" | "providerPayload" | "lastHeartbeatAt"
  >
>;

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

/** Machine 注册后，将同一 Machine 关联的活跃 Sandbox Instance 标记为 ready。 */
export async function markSandboxInstanceReadyByMachineId(machineId: string, at = new Date()): Promise<void> {
  await db
    .update(sandboxInstance)
    .set({ status: "ready", lastHeartbeatAt: at, updatedAt: at })
    .where(
      and(
        eq(sandboxInstance.machineId, machineId),
        inArray(sandboxInstance.status, ["creating", "starting", "recovering"]),
      ),
    );
}

/** Machine 心跳通过 machine_id 更新关联 Sandbox Instance 的活跃时间。 */
export async function touchSandboxInstanceHeartbeatByMachineId(machineId: string, at = new Date()): Promise<void> {
  await db
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
