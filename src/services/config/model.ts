import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { model, provider } from "../../db/schema";
import { NotFoundError } from "../../errors";
import type { AuthContext } from "../../plugins/auth";
import { assertInternalWritable } from "../resource-permission";
import type { ModelCostConfig, ModelLimitConfig, ModelModalities, ModelOptions } from "./types";

// ────────────────────────────────────────────
// Model 操作
//
// 所有 model 写操作继承 provider 可写性，外部 provider 下的模型只能读取。
// ────────────────────────────────────────────

/** 构建 model 写入字段（addModel 的 values 和 set 共享） */
function buildModelValues(data: {
  displayName?: string;
  modalities?: ModelModalities | null;
  limitConfig?: ModelLimitConfig | null;
  cost?: ModelCostConfig | null;
  options?: ModelOptions | null;
}) {
  return {
    displayName: data.displayName,
    modalities: data.modalities ?? undefined,
    limitConfig: data.limitConfig ?? undefined,
    cost: data.cost ?? undefined,
    options: data.options ?? undefined,
    updatedAt: new Date(),
  };
}

async function getWritableProvider(ctx: AuthContext, providerId: string) {
  const rows = await db.select().from(provider).where(eq(provider.id, providerId)).limit(1);
  const row = rows[0] ?? null;
  if (!row) throw new NotFoundError(`Provider '${providerId}' not found`);
  assertInternalWritable(ctx, "provider", row.id, row.organizationId);
  return row;
}

export async function addModel(
  ctx: AuthContext,
  providerId: string,
  data: {
    modelId: string;
    displayName?: string;
    modalities?: ModelModalities | null;
    limitConfig?: ModelLimitConfig | null;
    cost?: ModelCostConfig | null;
    options?: ModelOptions | null;
  },
) {
  const providerRow = await getWritableProvider(ctx, providerId);
  const fields = buildModelValues(data);
  await db
    .insert(model)
    .values({ organizationId: providerRow.organizationId, providerId, modelId: data.modelId, ...fields })
    .onConflictDoUpdate({
      target: [model.providerId, model.modelId],
      set: fields,
    });
}

export async function updateModel(
  ctx: AuthContext,
  providerId: string,
  modelId: string,
  data: {
    displayName?: string;
    modalities?: ModelModalities | null;
    limitConfig?: ModelLimitConfig | null;
    cost?: ModelCostConfig | null;
    options?: ModelOptions | null;
  },
): Promise<boolean> {
  const providerRow = await getWritableProvider(ctx, providerId);
  const set: Partial<typeof model.$inferInsert> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = data.modalities;
  if (data.limitConfig !== undefined) set.limitConfig = data.limitConfig;
  if (data.cost !== undefined) set.cost = data.cost;
  if (data.options !== undefined) set.options = data.options;

  const result = await db
    .update(model)
    .set(set)
    .where(
      and(
        eq(model.organizationId, providerRow.organizationId),
        eq(model.providerId, providerId),
        eq(model.modelId, modelId),
      ),
    )
    .returning({ id: model.id });
  return result.length > 0;
}

export async function removeModel(ctx: AuthContext, providerId: string, modelId: string): Promise<boolean> {
  const providerRow = await getWritableProvider(ctx, providerId);
  const result = await db
    .delete(model)
    .where(
      and(
        eq(model.organizationId, providerRow.organizationId),
        eq(model.providerId, providerId),
        eq(model.modelId, modelId),
      ),
    )
    .returning({ id: model.id });
  return result.length > 0;
}
