import { db } from "../../db";
import { provider, model } from "../../db/schema";
import { eq, and, sql } from "drizzle-orm";

// ────────────────────────────────────────────
// Provider 操作
// ────────────────────────────────────────────

export async function listProviders(userId: string) {
  const rows = await db.select({
    id: provider.id,
    name: provider.name,
    displayName: provider.displayName,
    npm: provider.npm,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    extraOptions: provider.extraOptions,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    modelCount: sql<number>`(SELECT COUNT(*) FROM ${model} WHERE ${model.providerId} = ${provider.id})`,
  })
    .from(provider)
    .where(eq(provider.userId, userId));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    npm: r.npm,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    extraOptions: r.extraOptions,
    modelCount: Number(r.modelCount),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function getProvider(userId: string, name: string) {
  const rows = await db.select().from(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .limit(1);
  if (rows.length === 0) return null;
  const p = rows[0];

  const models = await db.select().from(model)
    .where(eq(model.providerId, p.id));

  return { ...p, models };
}

export async function upsertProvider(
  userId: string,
  name: string,
  data: {
    displayName?: string;
    npm?: string;
    baseUrl?: string;
    apiKey?: string;
    extraOptions?: Record<string, unknown>;
  },
) {
  const existing = await db.select({ id: provider.id }).from(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(provider)
      .set({
        displayName: data.displayName,
        npm: data.npm,
        baseUrl: data.baseUrl,
        apiKey: data.apiKey,
        extraOptions: data.extraOptions ? JSON.stringify(data.extraOptions) : undefined,
        updatedAt: new Date(),
      })
      .where(eq(provider.id, existing[0].id));
    return existing[0].id;
  }

  const inserted = await db.insert(provider).values({
    userId,
    name,
    displayName: data.displayName,
    npm: data.npm,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    extraOptions: data.extraOptions ? JSON.stringify(data.extraOptions) : undefined,
  }).returning({ id: provider.id });
  return inserted[0].id;
}

export async function deleteProvider(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .returning({ id: provider.id });
  return result.length > 0;
}
