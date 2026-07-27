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
import { createNotification } from "./notification";
import { resolveRagflowApiKey } from "./ragflow-key";

const KNOWLEDGE_UPLOAD_ROOT = join(process.cwd(), "data/knowledge-upload");

/** 跨组织安全的 KB 查询 + API key 解析 */
async function resolveKb(organizationId: string, knowledgeBaseId: string, userId: string) {
  const kb = await knowledgeBaseRepo.getById(knowledgeBaseId);
  if (!kb) return null;
  if (kb.organizationId !== organizationId) return null;
  const apiKey = await resolveRagflowApiKey("global", userId, organizationId);
  return { kb, apiKey };
}

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

  // 先按 sourceName 检查是否已有同名资源
  const existing = await knowledgeResourceRepo.getBySourceName(knowledgeBaseId, sourceName);
  if (existing) {
    // 同名已有 → 复用记录，重置为 pending
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
    remoteId: null,
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

export async function uploadKnowledgeResource(
  organizationId: string,
  knowledgeBaseId: string,
  file: File,
  overwrite?: boolean,
  userId?: string,
) {
  const resolved = await resolveKb(organizationId, knowledgeBaseId, userId ?? organizationId);
  if (!resolved) throw new Error("知识库不存在");
  const { kb, apiKey } = resolved;
  if (!kb.remoteId) throw new Error("知识库 remoteId 不存在");

  const sourceName = basename(file.name || "upload.bin");

  // 覆盖模式：先删除同名旧资源（远端 + 本地），再上传新文件
  if (overwrite) {
    const existing = await knowledgeResourceRepo.getBySourceName(knowledgeBaseId, sourceName);
    if (existing) {
      // 删除远端 RagFlow 文档
      if (existing.remoteId) {
        const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
        try {
          await getKnowledgeProvider().deleteResource({
            resourceRemoteId: existing.remoteId,
            knowledgeBaseRemoteId: kb.remoteId,
            remoteAccountId: tenantIdentity.remoteAccountId,
            remoteUserId: tenantIdentity.remoteUserId,
            recursive: true,
            apiKey,
          });
        } catch (err) {
          console.warn("[knowledge-upload] 覆盖前删除远端文档失败（继续上传）:", err);
        }
      }
      // 删除本地记录
      await knowledgeResourceRepo.delete(existing.id);
    }
  }

  const dir = join(KNOWLEDGE_UPLOAD_ROOT, organizationId, knowledgeBaseId);
  await mkdir(dir, { recursive: true });
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
      apiKey,
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
  organizationId: string,
  knowledgeBaseId: string,
  input: { url: string; sourceName?: string },
  userId?: string,
) {
  const resolved = await resolveKb(organizationId, knowledgeBaseId, userId ?? organizationId);
  if (!resolved) throw new Error("知识库不存在");
  const { kb, apiKey } = resolved;
  if (!kb.remoteId) throw new Error("知识库 remoteId 不存在");

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
      apiKey,
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

export async function listKnowledgeResources(organizationId: string, knowledgeBaseId: string, userId?: string) {
  const resolved = await resolveKb(organizationId, knowledgeBaseId, userId ?? organizationId);
  if (!resolved) return null;
  const rows = await knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId);
  return rows.map(sanitizeResource);
}

export async function deleteKnowledgeResource(
  organizationId: string,
  knowledgeBaseId: string,
  resourceId: string,
  userId?: string,
) {
  const resolved = await resolveKb(organizationId, knowledgeBaseId, userId ?? organizationId);
  if (!resolved) return { success: false as const, error: { code: "NOT_FOUND", message: "知识库不存在" } };
  const { kb, apiKey } = resolved;
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
        apiKey,
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

export async function refreshKnowledgeResourceStatus(organizationId: string, knowledgeBaseId: string, userId?: string) {
  const kb = await knowledgeBaseRepo.getById(knowledgeBaseId);
  if (!kb) {
    return null;
  }
  if (kb.organizationId !== organizationId) return null;
  if (!kb.remoteId) {
    return [];
  }

  const apiKeyUserId = userId ?? kb.userId;
  const tenantIdentity = resolveKnowledgeTenantIdentity(kb);

  // 尝试从 RAGFlow 同步最新状态；失败时回退到本地缓存数据
  try {
    const apiKey = await resolveRagflowApiKey("global", userId ?? kb.userId, organizationId);
    const remoteResources = await getKnowledgeProvider().listResources({
      knowledgeBaseRemoteId: kb.remoteId,
      remoteAccountId: tenantIdentity.remoteAccountId,
      remoteUserId: tenantIdentity.remoteUserId,
      apiKey,
    });
    const localResources = await listKnowledgeBaseResources(knowledgeBaseId);
    const byRemoteId = new Map(
      localResources.filter((row) => row.remoteId).map((row) => [row.remoteId as string, row]),
    );

    for (const remote of remoteResources) {
      let local = byRemoteId.get(remote.remoteId);
      if (!local) {
        // 远端有但本地没有的资源（如导入的 KB），自动创建本地记录
        const now = new Date();
        const created = await knowledgeResourceRepo.create({
          knowledgeBaseId,
          sourceType: remote.sourceType,
          sourceName: remote.sourceName,
          sourcePath: remote.source ?? null,
          remoteId: remote.remoteId,
          status: remote.status,
          lastError: remote.lastError ?? null,
          createdAt: now,
          updatedAt: now,
        });
        local = created;
        byRemoteId.set(remote.remoteId, local);
      }
      // 检测状态变更并发送通知
      const oldStatus = local.status;
      const newStatus = remote.status;
      const sourceName = remote.sourceName || local.sourceName || "unknown";

      if (oldStatus !== newStatus) {
        if (newStatus === "ready") {
          // 文档向量化完成 → 通知上传者和管理员
          createNotification({
            type: "knowledge",
            subType: "doc_vectorized",
            title: `《${sourceName}》已向量化完成`,
            content: `文档《${sourceName}》在知识库「${kb.name}」中已完成向量化处理`,
            targetUrl: `/knowledge/bases/${knowledgeBaseId}`,
            metadata: { kbId: knowledgeBaseId, kbName: kb.name, resourceId: local.id, fileName: sourceName },
            userId: kb.userId, // 通知上传者（KB 的 userId）
            organizationId: kb.organizationId,
          }).catch((err: unknown) => console.error("[notification] doc vectorized failed:", err));
        } else if (newStatus === "error") {
          // 文档解析失败 → 通知上传者和管理员
          const errMsg = remote.lastError || "请检查文件格式";
          createNotification({
            type: "knowledge",
            subType: "doc_parse_failed",
            title: `《${sourceName}》解析失败`,
            content: `文档《${sourceName}》在知识库「${kb.name}」中解析失败：${errMsg}`,
            targetUrl: `/knowledge/bases/${knowledgeBaseId}`,
            metadata: {
              kbId: knowledgeBaseId,
              kbName: kb.name,
              resourceId: local.id,
              fileName: sourceName,
              error: errMsg,
            },
            userId: kb.userId,
            organizationId: kb.organizationId,
          }).catch((err: unknown) => console.error("[notification] doc parse failed:", err));
        }
      }

      await knowledgeResourceRepo.update(local.id, {
        status: remote.status,
        lastError: remote.lastError ?? null,
        updatedAt: new Date(),
      });
    }
    await upsertKnowledgeBaseStatusFromResources(knowledgeBaseId);

    // 合并本地行与远端额外字段返回
    const rows = await knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId);
    const remoteById = new Map(remoteResources.map((r) => [r.remoteId, r]));
    return rows.map((row) => {
      const base = sanitizeResource(row);
      const remote = row.remoteId ? remoteById.get(row.remoteId) : undefined;
      if (!remote) return base;
      return {
        ...base,
        sourceName: remote.sourceName,
        sourceType: remote.sourceType,
        status: remote.status,
        enabled: remote.enabled,
        chunkCount: remote.chunkCount,
        metaFields: remote.metaFields,
        parseProgress: remote.parseProgress,
        runStatus: remote.runStatus,
        chunkMethod: remote.chunkMethod,
        fileSize: remote.fileSize,
      };
    });
  } catch (ragErr) {
    console.error("[knowledge] Failed to sync from RAGFlow, returning local cache:", (ragErr as Error).message);
  }

  // RAGFlow 不可用时返回本地缓存数据
  const rows = await knowledgeResourceRepo.listByKnowledgeBase(knowledgeBaseId);
  return rows.map((row) => sanitizeResource(row));
}
