import { db } from "../../db";
import { model } from "../../db/schema";
import { eq, and } from "drizzle-orm";

// ────────────────────────────────────────────
// Model 操作
// ────────────────────────────────────────────

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
  await db.insert(model).values({
    providerId,
    modelId: data.modelId,
    displayName: data.displayName,
    modalities: data.modalities ? JSON.stringify(data.modalities) : undefined,
    limitConfig: data.limitConfig ? JSON.stringify(data.limitConfig) : undefined,
    cost: data.cost ? JSON.stringify(data.cost) : undefined,
    options: data.options ? JSON.stringify(data.options) : undefined,
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
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = JSON.stringify(data.modalities);
  if (data.limitConfig !== undefined) set.limitConfig = JSON.stringify(data.limitConfig);
  if (data.cost !== undefined) set.cost = JSON.stringify(data.cost);
  if (data.options !== undefined) set.options = JSON.stringify(data.options);

  await db.update(model).set(set)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)));
}

export async function removeModel(providerId: string, modelId: string): Promise<boolean> {
  const result = await db.delete(model)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}
