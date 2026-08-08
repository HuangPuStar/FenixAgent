import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { type NewSandboxPool, type SandboxPool, sandboxPool } from "../db/schema";

export function isSandboxPoolReadable(pool: Pick<SandboxPool, "organizationId">, organizationId: string): boolean {
  return pool.organizationId === null || pool.organizationId === organizationId;
}

export async function findSandboxPoolById(id: string): Promise<SandboxPool | null> {
  const [row] = await db.select().from(sandboxPool).where(eq(sandboxPool.id, id)).limit(1);
  return row ?? null;
}

export async function findReadableSandboxPoolById(id: string, organizationId: string): Promise<SandboxPool | null> {
  const [row] = await db
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
  return db
    .select()
    .from(sandboxPool)
    .where(or(isNull(sandboxPool.organizationId), eq(sandboxPool.organizationId, organizationId)));
}

export async function listSandboxPools(): Promise<SandboxPool[]> {
  return db.select().from(sandboxPool).orderBy(sandboxPool.createdAt);
}

export async function createSandboxPool(input: NewSandboxPool): Promise<SandboxPool> {
  const [row] = await db.insert(sandboxPool).values(input).returning();
  return row;
}

export async function updateSandboxPool(id: string, patch: Partial<NewSandboxPool>): Promise<SandboxPool | null> {
  const [row] = await db
    .update(sandboxPool)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sandboxPool.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSandboxPool(id: string): Promise<SandboxPool | null> {
  const [row] = await db.delete(sandboxPool).where(eq(sandboxPool.id, id)).returning();
  return row ?? null;
}

export async function upsertSandboxPool(input: NewSandboxPool): Promise<SandboxPool> {
  const [row] = await db
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
