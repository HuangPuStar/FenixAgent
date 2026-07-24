import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { KnowledgeResourceRow } from "../repositories/knowledge-base";
import { knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import {
  listKnowledgeBaseResources,
  resolveKnowledgeTenantIdentity,
  touchKnowledgeBaseUpdatedAt,
  upsertKnowledgeBaseStatusFromResources,
} from "./knowledge-base";
import { getKnowledgeProvider } from "./knowledge-provider/registry";
import type { KnowledgeResourceStatus } from "./knowledge-provider/types";

const KNOWLEDGE_UPLOAD_ROOT = join(process.cwd(), "data/knowledge-upload");

function generateKnowledgeResourceId(): string {
  return randomUUID();
}

export { setKnowledgeProviderForTesting as setKnowledgeUploadProviderForTesting } from "./knowledge-provider/registry";

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
    enabled: null,
    chunkCount: null,
    metaFields: null,
    parseProgress: null,
    runStatus: null,
    chunkMethod: null,
    fileSize: null,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  };
}

/**
 * 判断远端文档删除失败是否只是“对象已不存在”。
 * 本地资源删除保持幂等，避免 RagFlow 侧人工清理后前端无法移除残留记录。
 */
function isRemoteKnowledgeResourceMissingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("not exist") ||
    message.includes("nonexistent") ||
    message.includes("document not found") ||
    message.includes("http 404")
  );
}

async function createOrReusePendingResource(
  knowledgeBaseId: string,
  sourceType: string,
  sourceName: string,
  sourcePath: string | null,
) {
  const now = new Date();

  // 先按 sourceName 检查是否已有同名资源（防止并发重复上传到 RagFlow）
  const existing = await knowledgeResourceRepo.getBySourceName(knowledgeBaseId, sourceName);
  if (existing) {
    await knowledgeResourceRepo.update(existing.id, {
      sourceType,
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
    remoteId: null, // remoteId 在 provider.addResource 返回 document_id 后才写入
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

async function completeResource(
  resourceId: string,
  knowledgeBaseId: string,
  patch: {
    remoteId?: string | null;
    knowledgeBaseRemoteId?: string | null;
    status: KnowledgeResourceStatus;
    lastError?: string | null;
  },
) {
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
  const kb = await knowledgeBaseRepo.getByOrgAndId(userId, knowledgeBaseId);
  if (!kb) {
    throw new Error("知识库不存在");
  }
  if (!kb.remoteId) {
    throw new Error("知识库 remoteId 不存在");
  }

  const dir = join(KNOWLEDGE_UPLOAD_ROOT, userId, knowledgeBaseId);
  await mkdir(dir, { recursive: true });
  const sourceName = basename(file.name || "upload.bin");
  const filePath = join(dir, `${Date.now()}-${sourceName}`);
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

  const resourceId = await createOrReusePendingResource(knowledgeBaseId, "upload", sourceName, filePath);

  try {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    const remote = await getKnowledgeProvider().addResource({
      knowledgeBaseRemoteId: kb.remoteId,
      remoteAccountId: tenantIdentity.remoteAccountId,
      remoteUserId: tenantIdentity.remoteUserId,
      filePath,
      sourceName,
    });

    await completeResource(resourceId, knowledgeBaseId, {
      remoteId: remote.remoteId,
      knowledgeBaseRemoteId: remote.knowledgeBaseRemoteId ?? kb.remoteId,
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
  const kb = await knowledgeBaseRepo.getByOrgAndId(userId, knowledgeBaseId);
  if (!kb) {
    throw new Error("知识库不存在");
  }
  if (!kb.remoteId) {
    throw new Error("知识库 remoteId 不存在");
  }

  const sourceName = input.sourceName?.trim() || basename(new URL(input.url).pathname || "resource");
  const resourceId = await createOrReusePendingResource(knowledgeBaseId, "url", sourceName || input.url, input.url);

  try {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    const remote = await getKnowledgeProvider().addResource({
      knowledgeBaseRemoteId: kb.remoteId,
      remoteAccountId: tenantIdentity.remoteAccountId,
      remoteUserId: tenantIdentity.remoteUserId,
      url: input.url,
      sourceName: input.sourceName,
    });

    await completeResource(resourceId, knowledgeBaseId, {
      remoteId: remote.remoteId,
      knowledgeBaseRemoteId: remote.knowledgeBaseRemoteId ?? kb.remoteId,
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
  const kb = await knowledgeBaseRepo.getByOrgAndId(userId, knowledgeBaseId);
  if (!kb) {
    return null;
  }
  const rows = await knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId);

  // 如果有 remoteId，尝试从 RagFlow 拉取富信息（chunkCount / enabled / runStatus / parseProgress）
  if (kb.remoteId) {
    try {
      const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
      const remoteResources = await getKnowledgeProvider().listResources({
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: tenantIdentity.remoteAccountId,
        remoteUserId: tenantIdentity.remoteUserId,
      });
      const remoteByRemoteId = new Map(remoteResources.map((r) => [r.remoteId, r]));
      const updatePromises: Promise<void>[] = [];
      const enriched = rows.map((row) => {
        const base = sanitizeResource(row);
        if (!row.remoteId) return base;
        const remote = remoteByRemoteId.get(row.remoteId);
        if (!remote) return base;
        // 将远端状态回写到本地 DB，确保知识库状态能正确反映
        if (row.status !== remote.status) {
          updatePromises.push(
            knowledgeResourceRepo
              .update(row.id, {
                status: remote.status,
                lastError: remote.lastError ?? null,
                updatedAt: new Date(),
              })
              .catch((err) => console.warn("[knowledge-upload] failed to update resource status:", err)),
          );
          base.status = remote.status;
          base.lastError = remote.lastError ?? null;
        }
        return {
          ...base,
          enabled: remote.enabled ?? null,
          chunkCount: remote.chunkCount ?? null,
          runStatus: remote.runStatus ?? null,
          parseProgress: remote.parseProgress ?? null,
        };
      });
      // 先等所有状态更新写入 DB，再基于最新数据计算 KB 状态
      if (updatePromises.length > 0) {
        await Promise.all(updatePromises);
        await upsertKnowledgeBaseStatusFromResources(knowledgeBaseId);
      }
      return enriched;
    } catch (err) {
      // RagFlow 不可用时降级为本地数据
      console.warn("[knowledge-upload] failed to enrich resources from RagFlow:", err);
    }
  }

  return rows.map(sanitizeResource);
}

export async function deleteKnowledgeResource(userId: string, knowledgeBaseId: string, resourceId: string) {
  const kb = await knowledgeBaseRepo.getByOrgAndId(userId, knowledgeBaseId);
  if (!kb) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "知识库不存在" } };
  }
  const resourceRow = await knowledgeResourceRepo.getById(resourceId);
  if (!resourceRow || resourceRow.knowledgeBaseId !== knowledgeBaseId) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "资源不存在" } };
  }

  if (resourceRow.remoteId) {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    try {
      await getKnowledgeProvider().deleteResource({
        resourceRemoteId: resourceRow.remoteId,
        knowledgeBaseRemoteId: kb.remoteId!,
        remoteAccountId: tenantIdentity.remoteAccountId,
        remoteUserId: tenantIdentity.remoteUserId,
        recursive: true,
      });
    } catch (err) {
      console.error(err);
      if (!isRemoteKnowledgeResourceMissingError(err)) {
        throw err;
      }
      console.warn("Remote knowledge resource is already missing; continuing local deletion", {
        resourceId,
        remoteId: resourceRow.remoteId,
        knowledgeBaseId,
      });
    }
  }

  await knowledgeResourceRepo.delete(resourceId);
  await upsertKnowledgeBaseStatusFromResources(knowledgeBaseId);

  return { success: true as const, data: null };
}

export async function refreshKnowledgeResourceStatus(userId: string, knowledgeBaseId: string) {
  const kb = await knowledgeBaseRepo.getByOrgAndId(userId, knowledgeBaseId);
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
  const byRemoteId = new Map(localResources.filter((row) => row.remoteId).map((row) => [row.remoteId as string, row]));

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
  // 将远端富信息合并到本地行上
  const updatedRows = await listKnowledgeBaseResources(knowledgeBaseId);
  const refreshed = updatedRows.map((row) => {
    const base = sanitizeResource(row);
    if (!row.remoteId) return base;
    const remote = remoteResources.find((r) => r.remoteId === row.remoteId);
    if (!remote) return base;
    return {
      ...base,
      enabled: remote.enabled ?? null,
      chunkCount: remote.chunkCount ?? null,
      runStatus: remote.runStatus ?? null,
      parseProgress: remote.parseProgress ?? null,
    };
  });
  return refreshed;
}
