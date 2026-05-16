import { randomBytes } from "node:crypto";
import {
  knowledgeBaseRepo,
  knowledgeResourceRepo,
  agentKnowledgeBindingRepo,
} from "../repositories/knowledge-base";
import type { KnowledgeBaseRow } from "../repositories/knowledge-base";
import { config } from "../config";
import { createKnowledgeProvider } from "./knowledge-provider/openviking";
import type {
  KnowledgeBaseStatus,
  KnowledgeProvider,
  KnowledgeResourceStatus,
} from "./knowledge-provider/types";

export interface KnowledgeTenantIdentity {
  remoteAccountId: string;
  remoteUserId: string;
}

function generateKnowledgeBaseId(): string {
  return `kb_${randomBytes(8).toString("hex")}`;
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function normalizeUriSegment(value: string): string {
  return value.trim().replace(/[\\/]/g, "_");
}

export function buildKnowledgeBaseRemoteId(userId: string, slug: string): string {
  return `viking://resources/kb/${normalizeUriSegment(userId)}/${normalizeUriSegment(normalizeSlug(slug))}/`;
}

function validateName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "知识库名称不能为空";
  }
  if (name.trim().length > 120) {
    return "知识库名称不能超过 120 字符";
  }
  return null;
}

function validateSlug(slug: string): string | null {
  const normalized = normalizeSlug(slug);
  if (!normalized) {
    return "slug 不能为空";
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    return "slug 必须为 kebab-case";
  }
  if (normalized.length > 80) {
    return "slug 不能超过 80 字符";
  }
  return null;
}

function toUnixTimestamp(value: Date | null | undefined): number | null {
  return value ? Math.floor(value.getTime() / 1000) : null;
}

let knowledgeProvider: KnowledgeProvider | null = null;

function getKnowledgeProvider(): KnowledgeProvider {
  if (!knowledgeProvider) {
    knowledgeProvider = createKnowledgeProvider();
  }
  return knowledgeProvider;
}

export function setKnowledgeProviderForTesting(provider: KnowledgeProvider | null) {
  knowledgeProvider = provider;
}

function sanitizeKnowledgeBase(
  row: KnowledgeBaseRow,
  extras?: {
    bindingsCount?: number;
    resourcesCount?: number;
    recentResources?: Array<{
      id: string;
      sourceName: string;
      sourceType: string;
      status: KnowledgeResourceStatus;
      lastError: string | null;
      createdAt: number;
      updatedAt: number;
    }>;
  },
) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    provider: row.provider,
    remoteId: row.remoteId ?? null,
    remoteAccountId: row.remoteAccountId ?? null,
    remoteUserId: row.remoteUserId ?? null,
    status: row.status as KnowledgeBaseStatus,
    lastError: row.lastError ?? null,
    bindingsCount: extras?.bindingsCount ?? 0,
    resourcesCount: extras?.resourcesCount ?? 0,
    recentResources: extras?.recentResources ?? [],
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  };
}

export function resolveKnowledgeTenantIdentity(
  row: Pick<KnowledgeBaseRow, "userId" | "remoteAccountId" | "remoteUserId">,
): KnowledgeTenantIdentity {
  const fallback = row.userId.trim();
  return {
    remoteAccountId: row.remoteAccountId?.trim() || fallback,
    remoteUserId: row.remoteUserId?.trim() || fallback,
  };
}

async function assertUniqueSlug(userId: string, slug: string, excludeId?: string) {
  const row = await knowledgeBaseRepo.findByUserAndSlug(userId, normalizeSlug(slug));
  if (row && row.id !== excludeId) {
    throw new Error(`知识库 slug '${normalizeSlug(slug)}' 已存在`);
  }
}

export async function countKnowledgeBaseBindings(knowledgeBaseId: string): Promise<number> {
  return knowledgeBaseRepo.countBindings(knowledgeBaseId);
}

export async function listKnowledgeBasesByUserId(userId: string) {
  const rows = await knowledgeBaseRepo.listByUserId(userId);
  const items = await Promise.all(rows.map(async (row) => sanitizeKnowledgeBase(row, {
    bindingsCount: await countKnowledgeBaseBindings(row.id),
    resourcesCount: await knowledgeResourceRepo.countByKnowledgeBase(row.id),
  })));
  return items;
}

export async function getKnowledgeBaseDetail(userId: string, knowledgeBaseId: string) {
  const row = await knowledgeBaseRepo.getByUserAndId(userId, knowledgeBaseId);
  if (!row) {
    return null;
  }
  const resourceRows = await knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId, 20);
  const bindingsCount = await countKnowledgeBaseBindings(knowledgeBaseId);
  const resourcesCount = await knowledgeResourceRepo.countByKnowledgeBase(knowledgeBaseId);
  return sanitizeKnowledgeBase(row, {
    bindingsCount,
    resourcesCount,
    recentResources: resourceRows.map((resource) => ({
      id: resource.id,
      sourceName: resource.sourceName,
      sourceType: resource.sourceType,
      status: resource.status as KnowledgeResourceStatus,
      lastError: resource.lastError ?? null,
      createdAt: Math.floor(resource.createdAt.getTime() / 1000),
      updatedAt: Math.floor(resource.updatedAt.getTime() / 1000),
    })),
  });
}

export async function createKnowledgeBaseRecord(
  userId: string,
  input: { name: string; slug: string; description?: string | null },
) {
  const nameError = validateName(input.name);
  if (nameError) {
    return { success: false as const, error: { code: "VALIDATION_ERROR", message: nameError } };
  }
  const slugError = validateSlug(input.slug);
  if (slugError) {
    return { success: false as const, error: { code: "VALIDATION_ERROR", message: slugError } };
  }

  try {
    await assertUniqueSlug(userId, input.slug);
  } catch (error) {
    return { success: false as const, error: { code: "VALIDATION_ERROR", message: (error as Error).message } };
  }

  const provider = getKnowledgeProvider();
  const tenantIdentity = resolveKnowledgeTenantIdentity({
    userId,
    remoteAccountId: userId,
    remoteUserId: userId,
  });
  const remote = await provider.createKnowledgeBase({
    userId,
    slug: normalizeSlug(input.slug),
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
  });

  const now = new Date();
  const remoteId = remote.remoteId ?? buildKnowledgeBaseRemoteId(userId, input.slug);
  const row = await knowledgeBaseRepo.create({
    id: generateKnowledgeBaseId(),
    userId,
    name: input.name.trim(),
    slug: normalizeSlug(input.slug),
    description: input.description?.trim() || null,
    provider: config.knowledgeProvider,
    remoteId,
    remoteAccountId: tenantIdentity.remoteAccountId,
    remoteUserId: tenantIdentity.remoteUserId,
    status: remote.status,
    lastError: remote.lastError ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return { success: true as const, data: sanitizeKnowledgeBase(row) };
}

export async function updateKnowledgeBase(
  userId: string,
  knowledgeBaseId: string,
  input: { name?: string; slug?: string; description?: string | null },
) {
  const row = await knowledgeBaseRepo.getByUserAndId(userId, knowledgeBaseId);
  if (!row) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "知识库不存在" } };
  }
  if (input.name !== undefined) {
    const nameError = validateName(input.name);
    if (nameError) {
      return { success: false as const, error: { code: "VALIDATION_ERROR", message: nameError } };
    }
  }
  if (input.slug !== undefined) {
    const slugError = validateSlug(input.slug);
    if (slugError) {
      return { success: false as const, error: { code: "VALIDATION_ERROR", message: slugError } };
    }
    try {
      await assertUniqueSlug(userId, input.slug, knowledgeBaseId);
    } catch (error) {
      return { success: false as const, error: { code: "VALIDATION_ERROR", message: (error as Error).message } };
    }
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) {
    updates.name = input.name.trim();
  }
  if (input.slug !== undefined) {
    updates.slug = normalizeSlug(input.slug);
  }
  if (input.description !== undefined) {
    updates.description = input.description?.trim() || null;
  }
  await knowledgeBaseRepo.update(knowledgeBaseId, updates);
  const updated = await knowledgeBaseRepo.getById(knowledgeBaseId);
  return { success: true as const, data: sanitizeKnowledgeBase(updated!) };
}

export async function deleteKnowledgeBase(userId: string, knowledgeBaseId: string) {
  const row = await knowledgeBaseRepo.getByUserAndId(userId, knowledgeBaseId);
  if (!row) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "知识库不存在" } };
  }
  if (row.remoteId) {
    const tenantIdentity = resolveKnowledgeTenantIdentity(row);
    await getKnowledgeProvider().deleteResource({
      resourceRemoteId: row.remoteId,
      remoteAccountId: tenantIdentity.remoteAccountId,
      remoteUserId: tenantIdentity.remoteUserId,
      recursive: true,
    });
  }
  await agentKnowledgeBindingRepo.deleteByKnowledgeBaseId(knowledgeBaseId);
  await knowledgeBaseRepo.delete(knowledgeBaseId);
  return { success: true as const, data: { ok: true } };
}

export async function touchKnowledgeBaseUpdatedAt(knowledgeBaseId: string, patch?: {
  status?: KnowledgeBaseStatus;
  lastError?: string | null;
  remoteId?: string | null;
}) {
  await knowledgeBaseRepo.update(knowledgeBaseId, {
    updatedAt: new Date(),
    ...(patch?.status ? { status: patch.status } : {}),
    ...(patch && "lastError" in patch ? { lastError: patch.lastError ?? null } : {}),
    ...(patch && "remoteId" in patch ? { remoteId: patch.remoteId ?? null } : {}),
  });
}

export async function listKnowledgeBaseResources(knowledgeBaseId: string, limit?: number) {
  return knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId, limit);
}

export async function upsertKnowledgeBaseStatusFromResources(knowledgeBaseId: string) {
  const summary = await knowledgeResourceRepo.getStatusSummary(knowledgeBaseId);

  let status: KnowledgeBaseStatus = "empty";
  if (summary.errorCount > 0) {
    status = "error";
  } else if (summary.activeCount > 0) {
    status = "indexing";
  } else if (summary.readyCount > 0) {
    status = "ready";
  }

  await touchKnowledgeBaseUpdatedAt(knowledgeBaseId, { status });
}
