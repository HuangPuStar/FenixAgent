import { db } from "../../db";
import { model } from "../../db/schema";
import { eq, and } from "drizzle-orm";

// ────────────────────────────────────────────
// Model 操作
// ────────────────────────────────────────────

/** 构建 model 写入字段（addModel 的 values 和 set 共享） */
function buildModelValues(data: {
  displayName?: string;
  modalities?: unknown;
  limitConfig?: unknown;
  cost?: unknown;
  options?: unknown;
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
  providerId: string,
  data: {
    modelId: string;
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
) {
  const fields = buildModelValues(data);
  await db.insert(model).values({ providerId, modelId: data.modelId, ...fields })
    .onConflictDoUpdate({
      target: [model.providerId, model.modelId],
      set: fields,
    });
}

export async function updateModel(
  providerId: string,
  modelId: string,
  data: {
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
) {
  const set: Partial<typeof model.$inferInsert> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = data.modalities;
  if (data.limitConfig !== undefined) set.limitConfig = data.limitConfig;
  if (data.cost !== undefined) set.cost = data.cost;
  if (data.options !== undefined) set.options = data.options;

  await db.update(model).set(set)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)));
}

export async function removeModel(providerId: string, modelId: string): Promise<boolean> {
  const result = await db.delete(model)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}
