import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { model, provider } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import { createLitellmOrg } from "../litellm";
import {
  assertInternalWritable,
  canReadResource,
  decorateResourceAccess,
  listReadableResourceRefs,
  setPublicRead,
} from "../resource-permission";
import type {
  ModelCostConfig,
  ModelDataInput,
  ModelEntryWithProviderAccess,
  ModelLimitConfig,
  ModelModalities,
  ModelOptions,
  ProviderSetOptions,
  ProviderUpsertData,
  ResourceAccess,
  UpsertProviderResult,
} from "./types";

// ────────────────────────────────────────────
// Provider 操作
// ────────────────────────────────────────────

type ProviderRow = typeof provider.$inferSelect;
type ProviderRowWithAccess = ProviderRow & { resourceAccess: ResourceAccess };
type ProviderDetailWithAccess = ProviderRowWithAccess & { models: ModelEntryWithProviderAccess[] };

function parseResourceKey(resourceKey: string) {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    sourceOrganizationId: resourceKey.slice(0, slashIndex),
    resourceUid: resourceKey.slice(slashIndex + 1),
  };
}

async function listExternalProviders(ctx: AuthContext): Promise<ProviderRow[]> {
  const refs = await listReadableResourceRefs(ctx, "provider");
  const ids = refs.map((ref) => ref.resourceId);
  if (ids.length === 0) return [];

  const rows = await db.select().from(provider).where(inArray(provider.id, ids));
  const refKeys = new Set(refs.map((ref) => `${ref.organizationId}/${ref.resourceId}`));
  return rows.filter((row) => refKeys.has(`${row.organizationId}/${row.id}`));
}

export async function listReadableProviders(ctx: AuthContext): Promise<ProviderRowWithAccess[]> {
  const rows = await db.select().from(provider).where(eq(provider.organizationId, ctx.organizationId));
  const external = await listExternalProviders(ctx);
  return decorateResourceAccess(ctx, "provider", [...rows, ...external]);
}

export async function listProviders(ctx: AuthContext) {
  const rows = await listReadableProviders(ctx);
  const providerIds = rows.map((r) => r.id);
  const modelCounts =
    providerIds.length > 0
      ? await db
          .select({
            providerId: model.providerId,
            count: sql<number>`COUNT(*)`,
          })
          .from(model)
          .where(inArray(model.providerId, providerIds))
          .groupBy(model.providerId)
      : [];
  const countByProviderId = new Map(modelCounts.map((r) => [r.providerId, Number(r.count)]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    protocol: r.protocol,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    extraOptions: r.extraOptions,
    resourceAccess: r.resourceAccess,
    resourceKey: r.resourceAccess.resourceKey,
    modelCount: countByProviderId.get(r.id) ?? 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function listModelsWithProviderAccess(
  providerRow: ProviderRowWithAccess,
): Promise<ModelEntryWithProviderAccess[]> {
  const models = await db.select().from(model).where(eq(model.providerId, providerRow.id));
  return models.map((m) => ({
    ...m,
    providerResourceAccess: providerRow.resourceAccess,
  }));
}

export async function getProviderByResourceKey(
  ctx: AuthContext,
  resourceKey: string,
): Promise<ProviderDetailWithAccess | null> {
  const parsed = parseResourceKey(resourceKey);
  if (!parsed) return null;

  const rows = await db.select().from(provider).where(eq(provider.id, parsed.resourceUid)).limit(1);
  const row = rows[0] ?? null;
  if (!row || row.organizationId !== parsed.sourceOrganizationId) return null;

  const readable = await canReadResource(ctx, "provider", row.id, row.organizationId);
  if (!readable) return null;

  const [decorated] = await decorateResourceAccess(ctx, "provider", [row]);
  const models = await listModelsWithProviderAccess(decorated);
  return { ...decorated, models };
}

export async function getProvider(ctx: AuthContext, name: string): Promise<ProviderDetailWithAccess | null> {
  if (parseResourceKey(name)) return getProviderByResourceKey(ctx, name);

  const rows = await db
    .select()
    .from(provider)
    .where(and(eq(provider.organizationId, ctx.organizationId), eq(provider.name, name)))
    .limit(1);
  const internal = rows[0] ?? null;
  if (internal) {
    const [decorated] = await decorateResourceAccess(ctx, "provider", [internal]);
    const models = await listModelsWithProviderAccess(decorated);
    return { ...decorated, models };
  }

  const external = (await listExternalProviders(ctx)).find((row) => row.name === name);
  if (!external) return null;
  const readable = await canReadResource(ctx, "provider", external.id, external.organizationId);
  if (!readable) return null;

  const [decorated] = await decorateResourceAccess(ctx, "provider", [external]);
  const models = await listModelsWithProviderAccess(decorated);
  return { ...decorated, models };
}

export async function getProviderById(ctx: AuthContext, providerId: string): Promise<ProviderDetailWithAccess | null> {
  const rows = await db.select().from(provider).where(eq(provider.id, providerId)).limit(1);
  const row = rows[0] ?? null;
  if (!row) return null;

  if (row.organizationId === ctx.organizationId) {
    const [decorated] = await decorateResourceAccess(ctx, "provider", [row]);
    const models = await listModelsWithProviderAccess(decorated);
    return { ...decorated, models };
  }

  const readable = await canReadResource(ctx, "provider", row.id, row.organizationId);
  if (!readable) return null;

  const [decorated] = await decorateResourceAccess(ctx, "provider", [row]);
  const models = await listModelsWithProviderAccess(decorated);
  return { ...decorated, models };
}

export async function upsertProvider(
  ctx: AuthContext,
  name: string,
  data: ProviderUpsertData,
  options: ProviderSetOptions = {},
): Promise<UpsertProviderResult> {
  const set = {
    displayName: data.displayName,
    protocol: data.protocol,
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

  if (options.publicReadable !== undefined) {
    await setPublicRead(ctx, "provider", ctx.organizationId, row.id, options.publicReadable);
  }

  // LiteLLM 协议：首次创建时同步创建 LiteLLM Organization
  if (data.protocol === "litellm") {
    const existingExtra = (data.extraOptions ?? {}) as Record<string, unknown>;
    if (!existingExtra.litellmOrgId) {
      try {
        const orgAlias = `${ctx.organizationId}__${name}`;
        const litellmOrg = await createLitellmOrg(orgAlias);
        // Update extraOptions with litellmOrgId
        await db
          .update(provider)
          .set({
            extraOptions: {
              ...existingExtra,
              litellmOrgId: litellmOrg.organization_id,
              litellmOrgCreatedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
            // biome-ignore lint/suspicious/noExplicitAny: jsonb column type is inferred as unknown by Drizzle ORM
          } as any)
          .where(eq(provider.id, row.id));
      } catch (err) {
        console.error("[LiteLLM] 创建 Organization 失败:", err);
        return {
          id: row.id,
          litellmOrgCreated: false,
          litellmOrgError: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return { id: row.id, litellmOrgCreated: true };
}

export async function updateProviderById(
  ctx: AuthContext,
  providerId: string,
  data: ProviderUpsertData,
  options: ProviderSetOptions = {},
): Promise<boolean> {
  const existing = await getProviderById(ctx, providerId);
  if (!existing) return false;

  assertInternalWritable(ctx, "provider", existing.id, existing.organizationId);
  const set: Partial<typeof provider.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.protocol !== undefined) set.protocol = data.protocol;
  if (data.baseUrl !== undefined) set.baseUrl = data.baseUrl;
  if (data.apiKey !== undefined) set.apiKey = data.apiKey;
  if (data.extraOptions !== undefined) set.extraOptions = data.extraOptions;

  const result = await db.update(provider).set(set).where(eq(provider.id, existing.id)).returning({ id: provider.id });
  if (result.length > 0 && options.publicReadable !== undefined) {
    await setPublicRead(ctx, "provider", ctx.organizationId, existing.id, options.publicReadable);
  }
  return result.length > 0;
}

export async function deleteProvider(ctx: AuthContext, name: string): Promise<boolean> {
  const row = await getProvider(ctx, name);
  if (!row) return false;

  assertInternalWritable(ctx, "provider", row.id, row.organizationId);
  const result = await db.delete(provider).where(eq(provider.id, row.id)).returning({ id: provider.id });
  return result.length > 0;
}

export async function deleteProviderById(ctx: AuthContext, providerId: string): Promise<boolean> {
  const row = await getProviderById(ctx, providerId);
  if (!row) return false;

  assertInternalWritable(ctx, "provider", row.id, row.organizationId);
  const result = await db.delete(provider).where(eq(provider.id, row.id)).returning({ id: provider.id });
  return result.length > 0;
}

export async function assertProviderInternalWritable(
  ctx: AuthContext,
  nameOrResourceKey: string,
): Promise<ProviderDetailWithAccess | null> {
  const row = parseResourceKey(nameOrResourceKey)
    ? await getProviderByResourceKey(ctx, nameOrResourceKey)
    : await getProvider(ctx, nameOrResourceKey);
  if (!row) return null;
  assertInternalWritable(ctx, "provider", row.id, row.organizationId);
  return row;
}

export async function assertProviderInternalWritableById(
  ctx: AuthContext,
  providerId: string,
): Promise<ProviderDetailWithAccess | null> {
  const row = await getProviderById(ctx, providerId);
  if (!row) return null;
  assertInternalWritable(ctx, "provider", row.id, row.organizationId);
  return row;
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
