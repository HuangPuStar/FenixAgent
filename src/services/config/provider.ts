import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { model, provider } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import type {
  ModelCostConfig,
  ModelDataInput,
  ModelLimitConfig,
  ModelModalities,
  ModelOptions,
  ProviderUpsertData,
} from "./types";

// ────────────────────────────────────────────
// Provider 操作
// ────────────────────────────────────────────

export async function listProviders(ctx: AuthContext) {
  const rows = await db
    .select({
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
    .where(eq(provider.organizationId, ctx.organizationId));

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

export async function getProvider(ctx: AuthContext, name: string) {
  const rows = await db
    .select()
    .from(provider)
    .where(and(eq(provider.organizationId, ctx.organizationId), eq(provider.name, name)))
    .limit(1);
  if (rows.length === 0) return null;
  const p = rows[0];

  const models = await db.select().from(model).where(eq(model.providerId, p.id));

  return { ...p, models };
}

export async function upsertProvider(ctx: AuthContext, name: string, data: ProviderUpsertData) {
  const set = {
    displayName: data.displayName,
    npm: data.npm,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    extraOptions: data.extraOptions ?? undefined,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(provider)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      name,
      ...set,
    })
    .onConflictDoUpdate({
      target: [provider.organizationId, provider.name],
      set,
    })
    .returning({ id: provider.id });

  return row.id;
}

export async function deleteProvider(ctx: AuthContext, name: string): Promise<boolean> {
  const result = await db
    .delete(provider)
    .where(and(eq(provider.organizationId, ctx.organizationId), eq(provider.name, name)))
    .returning({ id: provider.id });
  return result.length > 0;
}

/** 将前端数据映射为 PG model 字段 */
export function buildModelData(data: ModelDataInput): {
  displayName?: string;
  modalities?: ModelModalities | null;
  limitConfig?: ModelLimitConfig | null;
  cost?: ModelCostConfig | null;
  options?: ModelOptions | null;
} {
  const result: {
    displayName?: string;
    modalities?: ModelModalities | null;
    limitConfig?: ModelLimitConfig | null;
    cost?: ModelCostConfig | null;
    options?: ModelOptions | null;
  } = {};
  if (typeof data.name === "string") result.displayName = data.name;
  if (data.modalities !== undefined) result.modalities = data.modalities as ModelModalities | null;
  if (data.limit !== undefined) result.limitConfig = data.limit as ModelLimitConfig | null;
  if (data.cost !== undefined) result.cost = data.cost as ModelCostConfig | null;
  if (data.options !== undefined) result.options = data.options as ModelOptions | null;
  return result;
}
