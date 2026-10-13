/**
 * 知识资源的上传、导入、状态刷新与删除。
 *
 * 本模块的每个入口都收**已授权的知识库行**（`KnowledgeBaseRow`）而不是 `(organizationId, knowledgeBaseId)`：
 * 归属判定与凭据解析属于门面（见 `../facades/knowledge-access`）。迁移前这里有一份私有的
 * `resolveKb` 同时做「读行 + 比较组织 + 解析 key」，与 `services/knowledge-base-access` 的同名判定
 * 重复，且刷新路径还允许降级——同一规则三处实现，改错一处不会有人发现。
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { KnowledgeBaseRow, KnowledgeResourceRow } from "../repositories/knowledge-base";
import { knowledgeResourceRepo } from "../repositories/knowledge-base";
import {
  listKnowledgeBaseResources,
  resolveKnowledgeTenantIdentity,
  touchKnowledgeBaseUpdatedAt,
  upsertKnowledgeBaseStatusFromResources,
} from "./knowledge-base";
import type { KnowledgeBaseCredential } from "./knowledge-credential";
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
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
  };
}

/**
 * 知识资源的对外 DTO：由本地行扁平化得到（刷新端点会再并入远端字段）。
 *
 * 由类型从实现反推，避免门面与路由各自手抄一份"看起来一样"的结构。
 */
export type KnowledgeResourceDto = ReturnType<typeof sanitizeResource>;

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

/**
 * 上传一个文件资源到已授权的知识库。
 *
 * 凭据惰性：门面已按调用者身份绑定取值动作，这里在真正要调 provider 时才取；未同步远端的知识库
 * （`remoteId` 为空）按迁移前的文案上抛，由门面映射为 404。
 */
export async function uploadKnowledgeResource(
  kb: KnowledgeBaseRow,
  credential: KnowledgeBaseCredential,
  file: File,
  overwrite?: boolean,
) {
  const knowledgeBaseId = kb.id;
  if (!kb.remoteId) throw new Error("知识库 remoteId 不存在");
  const apiKey = await credential();

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

  const dir = join(KNOWLEDGE_UPLOAD_ROOT, kb.organizationId, knowledgeBaseId);
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

/** 通过 URL 导入资源到已授权的知识库；远端失败不影响本地记录落库（返回 `error` 状态的 DTO）。 */
export async function importKnowledgeResourceFromUrl(
  kb: KnowledgeBaseRow,
  credential: KnowledgeBaseCredential,
  input: { url: string; sourceName?: string },
) {
  const knowledgeBaseId = kb.id;
  if (!kb.remoteId) throw new Error("知识库 remoteId 不存在");
  const apiKey = await credential();

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

/**
 * 把资源标记为"重新解析中"。
 *
 * 远端已受理重解析，本地状态先落库供前端轮询；只改状态与更新时间，不动资源内容，也不需要组织或凭据
 * （资源归属已由门面判定）。
 */
export async function markKnowledgeResourceProcessing(resourceId: string): Promise<void> {
  await knowledgeResourceRepo.update(resourceId, { status: "processing", updatedAt: new Date() });
}

/** 列出已授权知识库的本地资源行；只读本地，不访问远端，也不解析凭据。 */
export async function listKnowledgeResources(kb: KnowledgeBaseRow) {
  const rows = await knowledgeResourceRepo.listByKnowledgeBase(kb.id);
  return rows.map(sanitizeResource);
}

/**
 * 删除单个资源：远端删除保持幂等（远端已不存在时继续清理本地），再删除本地记录并重算知识库状态。
 *
 * 资源必须属于该知识库（`resourceRow.knowledgeBaseId !== knowledgeBaseId` 时判为不存在）；凭据惰性，
 * 只有存在远端文档时才解析。
 */
export async function deleteKnowledgeResource(
  kb: KnowledgeBaseRow,
  credential: KnowledgeBaseCredential,
  resourceId: string,
) {
  const knowledgeBaseId = kb.id;
  const resourceRow = await knowledgeResourceRepo.getById(resourceId);
  if (!resourceRow || resourceRow.knowledgeBaseId !== knowledgeBaseId) {
    return { success: false as const, error: { code: "NOT_FOUND", message: "资源不存在" } };
  }

  if (resourceRow.remoteId) {
    const tenantIdentity = resolveKnowledgeTenantIdentity(kb);
    const apiKey = await credential();
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

/**
 * 刷新已授权知识库的资源状态：先按远端为准同步，远端不可用（含凭据取不到）时退回本地缓存。
 *
 * 凭据在 `try` 内解析（惰性），因此「未配置 RAGFlow」与「远端抖动」走同一条降级路径；门面负责的是
 * 归属判定与「用谁的身份取凭据」，不改变这里的分支。
 */
export async function refreshKnowledgeResourceStatus(kb: KnowledgeBaseRow, credential: KnowledgeBaseCredential) {
  const knowledgeBaseId = kb.id;
  if (!kb.remoteId) {
    return [];
  }

  const tenantIdentity = resolveKnowledgeTenantIdentity(kb);

  // 尝试从 RAGFlow 同步最新状态；失败时回退到本地缓存数据
  try {
    const apiKey = await credential();
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
