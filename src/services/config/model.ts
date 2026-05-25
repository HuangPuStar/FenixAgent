import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { model } from "../../db/schema";
import type { ModelCostConfig, ModelLimitConfig, ModelModalities, ModelOptions } from "./types";

// ────────────────────────────────────────────
// Model 操作
//
// 所有函数以 organizationId 为首参数，WHERE 条件包含 organization_id 隔离。
// 调用方（通常是 routes/web/config/providers.ts）传入 authCtx.organizationId。
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

export async function addModel(
  organizationId: string,
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
  const fields = buildModelValues(data);
  await db
    .insert(model)
    .values({ organizationId, providerId, modelId: data.modelId, ...fields })
    .onConflictDoUpdate({
      target: [model.providerId, model.modelId],
      set: fields,
    });
}

export async function updateModel(
  organizationId: string,
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
  const set: Partial<typeof model.$inferInsert> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = data.modalities;
  if (data.limitConfig !== undefined) set.limitConfig = data.limitConfig;
  if (data.cost !== undefined) set.cost = data.cost;
  if (data.options !== undefined) set.options = data.options;

  const result = await db
    .update(model)
    .set(set)
    .where(and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}

export async function removeModel(organizationId: string, providerId: string, modelId: string): Promise<boolean> {
  const result = await db
    .delete(model)
    .where(and(eq(model.organizationId, organizationId), eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}
