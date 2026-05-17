import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../repositories/knowledge-base";
import type { KnowledgeResourceRow } from "../repositories/knowledge-base";
import { getKnowledgeProvider } from "./knowledge-provider/registry";
import type { KnowledgeProvider, KnowledgeResourceStatus } from "./knowledge-provider/types";
import {
  buildKnowledgeBaseRemoteId,
  listKnowledgeBaseResources,
  resolveKnowledgeTenantIdentity,
  touchKnowledgeBaseUpdatedAt,
  upsertKnowledgeBaseStatusFromResources,
} from "./knowledge-base";

const KNOWLEDGE_UPLOAD_ROOT = join(process.cwd(), "data/knowledge-upload");

function generateKnowledgeResourceId(): string {
  return randomUUID();
}

export { setKnowledgeProviderForTesting as setKnowledgeUploadProviderForTesting } from "./knowledge-provider/registry";

function isMissingParentUriError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Parent URI does not exist");
}

function sanitizeResourceName(value: string): string {
  return basename(value || "resource").replace(/[\\/]/g, "_");
}

function buildKnowledgeResourceRemoteId(knowledgeBaseRemoteId: string, sourceName: string): string {
  const root = knowledgeBaseRemoteId.endsWith("/") ? knowledgeBaseRemoteId : `${knowledgeBaseRemoteId}/`;
  return `${root}${sanitizeResourceName(sourceName)}`;
}

async function addResourceWithParentFallback(input: {
  provider: KnowledgeProvider;
  knowledgeBaseRemoteId?: string | null;
  targetRemoteId?: string | null;
  remoteAccountId: string;
  remoteUserId: string;
  filePath?: string;
  url?: string;
  sourceName?: string;
}) {
  try {
    return await input.provider.addResource({
      knowledgeBaseRemoteId: input.knowledgeBaseRemoteId ?? undefined,
      targetRemoteId: input.targetRemoteId ?? undefined,
      remoteAccountId: input.remoteAccountId,
      remoteUserId: input.remoteUserId,
      filePath: input.filePath,
      url: input.url,
      sourceName: input.sourceName,
    });
  } catch (error) {
    if (!input.knowledgeBaseRemoteId || !isMissingParentUriError(error)) {
      throw error;
    }
    return input.provider.addResource({
      targetRemoteId: input.targetRemoteId ?? undefined,
      remoteAccountId: input.remoteAccountId,
      remoteUserId: input.remoteUserId,
      filePath: input.filePath,
      url: input.url,
      sourceName: input.sourceName,
    });
  }
}

function sanitizeResource(row: KnowledgeResourceRow) {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledgeBaseId,
    sourceName: row.sourceName,
    sourceType: row.sourceType,
    sourcePath: row.sourcePath ?? null,
    remoteId: row.remoteId ?? null,
    status: row.status as KnowledgeResourceStatus,
    lastError: row.lastError ?? null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  };
}

async function createOrReusePendingResource(
  knowledgeBaseId: string,
  sourceType: string,
  sourceName: string,
  sourcePath: string | null,
  targetRemoteId: string,
) {
  const now = new Date();
  const existing = await knowledgeResourceRepo.getByRemoteId(knowledgeBaseId, targetRemoteId);

  if (existing) {
    await knowledgeResourceRepo.update(existing.id, {
      sourceType,
      sourceName,
      sourcePath,
      status: "pending",
      lastError: null,
      updatedAt: now,
    });
    return existing.id;
  }

  const id = generateKnowledgeResourceId();
  await knowledgeResourceRepo.create({
    id,
    knowledgeBaseId,
    sourceType,
    sourceName,
    sourcePath,
    remoteId: targetRemoteId,
    status: "pending",
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function failResource(resourceId: string, knowledgeBaseId: string, message: string) {
  await knowledgeResourceRepo.update(resourceId, {
    status: "error",
    lastError: message,
    updatedAt: new Date(),
  });
  await touchKnowledgeBaseUpdatedAt(knowledgeBaseId, {
    status: "error",
    lastError: message,
  });
}

async function completeResource(resourceId: string, knowledgeBaseId: string, patch: {
  remoteId?: string | null;
  knowledgeBaseRemoteId?: string | null;
  status: KnowledgeResourceStatus;
  lastError?: string | null;
}) {
  await knowledgeResourceRepo.update(resourceId, {
    remoteId: patch.remoteId ?? null,
    status: patch.status,
    lastError: patch.lastError ?? null,
    updatedAt: new Date(),
  });
  await touchKnowledgeBaseUpdatedAt(knowledgeBaseId, {
    ...(patch.knowledgeBaseRemoteId ? { remoteId: patch.knowledgeBaseRemoteId } : {}),
    status: patch.status === "ready" ? "ready" : "indexing",
    lastError: patch.lastError ?? null,
  });
}

export async function uploadKnowledgeResource(userId: string, knowledgeBaseId: string, file: File) {
  const kb = await knowledgeBaseRepo.getByTeamAndId(userId, knowledgeBaseId);
  if (!kb) {
    throw new Error("知识库不存在");
  }
  const knowledgeBaseRemoteId = kb.remoteId ?? buildKnowledgeBaseRemoteId(userId, kb.slug);
  const dir = join(KNOWLEDGE_UPLOAD_ROOT, userId, knowledgeBaseId);
  await mkdir(dir, { recursive: true });
  const sourceName = basename(file.name || "upload.bin");
  const filePath = join(dir, `${Date.now()}-${sourceName}`);
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
  const targetRemoteId = buildKnowledgeResourceRemoteId(knowledgeBaseRemoteId, sourceName);

  const resourceId = await createOrReusePendingResource(
    knowledgeBaseId,
    "upload",
    sourceName,
    filePath,
    targetRemoteId,
  );
  try {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    const remote = await addResourceWithParentFallback({
      provider: getKnowledgeProvider(),
      knowledgeBaseRemoteId,
      targetRemoteId,
      remoteAccountId: tenantIdentity.remoteAccountId,
      remoteUserId: tenantIdentity.remoteUserId,
      filePath,
      sourceName,
    });
    await completeResource(resourceId, knowledgeBaseId, {
      remoteId: remote.remoteId,
      knowledgeBaseRemoteId: remote.knowledgeBaseRemoteId ?? knowledgeBaseRemoteId,
      status: remote.status,
      lastError: remote.lastError ?? null,
    });
  } catch (error) {
    await failResource(resourceId, knowledgeBaseId, (error as Error).message);
  }

  const row = await knowledgeResourceRepo.getById(resourceId);
  return sanitizeResource(row!);
}

export async function importKnowledgeResourceFromUrl(
  userId: string,
  knowledgeBaseId: string,
  input: { url: string; sourceName?: string },
) {
  const kb = await knowledgeBaseRepo.getByTeamAndId(userId, knowledgeBaseId);
  if (!kb) {
    throw new Error("知识库不存在");
  }
  const knowledgeBaseRemoteId = kb.remoteId ?? buildKnowledgeBaseRemoteId(userId, kb.slug);
  const sourceName = input.sourceName?.trim() || basename(new URL(input.url).pathname || "resource");
  const targetRemoteId = buildKnowledgeResourceRemoteId(knowledgeBaseRemoteId, sourceName || input.url);
  const resourceId = await createOrReusePendingResource(
    knowledgeBaseId,
    "url",
    sourceName || input.url,
    input.url,
    targetRemoteId,
  );
  try {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    const remote = await addResourceWithParentFallback({
      provider: getKnowledgeProvider(),
      knowledgeBaseRemoteId,
      targetRemoteId,
      remoteAccountId: tenantIdentity.remoteAccountId,
      remoteUserId: tenantIdentity.remoteUserId,
      url: input.url,
      sourceName: input.sourceName,
    });
    await completeResource(resourceId, knowledgeBaseId, {
      remoteId: remote.remoteId,
      knowledgeBaseRemoteId: remote.knowledgeBaseRemoteId ?? knowledgeBaseRemoteId,
      status: remote.status,
      lastError: remote.lastError ?? null,
    });
  } catch (error) {
    await failResource(resourceId, knowledgeBaseId, (error as Error).message);
  }
  const row = await knowledgeResourceRepo.getById(resourceId);
  return sanitizeResource(row!);
}

export async function listKnowledgeResources(userId: string, knowledgeBaseId: string) {
  const kb = await knowledgeBaseRepo.getByTeamAndId(userId, knowledgeBaseId);
  if (!kb) {
    return null;
  }
  const rows = await knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId);
  return rows.map(sanitizeResource);
}

export async function deleteKnowledgeResource(userId: string, knowledgeBaseId: string, resourceId: string) {
  const kb = await knowledgeBaseRepo.getByTeamAndId(userId, knowledgeBaseId);
  if (!kb) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "知识库不存在" } };
  }
  const resourceRow = await knowledgeResourceRepo.getById(resourceId);
  if (!resourceRow || resourceRow.knowledgeBaseId !== knowledgeBaseId) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "资源不存在" } };
  }

  if (resourceRow.remoteId) {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    await getKnowledgeProvider().deleteResource({
      resourceRemoteId: resourceRow.remoteId,
      remoteAccountId: tenantIdentity.remoteAccountId,
      remoteUserId: tenantIdentity.remoteUserId,
      recursive: true,
    });
  }

  await knowledgeResourceRepo.delete(resourceId);
  await upsertKnowledgeBaseStatusFromResources(knowledgeBaseId);

  return { success: true as const, data: { ok: true } };
}

export async function refreshKnowledgeResourceStatus(userId: string, knowledgeBaseId: string) {
  const kb = await knowledgeBaseRepo.getByTeamAndId(userId, knowledgeBaseId);
  if (!kb) {
    return null;
  }
  if (!kb.remoteId) {
    return [];
  }
  const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
  const remoteResources = await getKnowledgeProvider().listResources({
    knowledgeBaseRemoteId: kb.remoteId,
    remoteAccountId: tenantIdentity.remoteAccountId,
    remoteUserId: tenantIdentity.remoteUserId,
  });
  const localResources = await listKnowledgeBaseResources(knowledgeBaseId);
  const byRemoteId = new Map(
    localResources
      .filter((row) => row.remoteId)
      .map((row) => [row.remoteId as string, row]),
  );

  for (const remote of remoteResources) {
    const local = byRemoteId.get(remote.remoteId);
    if (!local) {
      continue;
    }
    await knowledgeResourceRepo.update(local.id, {
      status: remote.status,
      lastError: remote.lastError ?? null,
      updatedAt: new Date(),
    });
  }
  await upsertKnowledgeBaseStatusFromResources(knowledgeBaseId);
  const rows = await listKnowledgeResources(userId, knowledgeBaseId);
  return rows ?? [];
}
