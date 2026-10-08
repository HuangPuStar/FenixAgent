/**
 * 知识资源的应用 Facade：资源的上传、导入、列表、删除、启停、重解析、切片与文件预览。
 *
 * 立这一层之前的形态是：路由先调一次 `findKnowledgeResourceInBase` 判资源归属，再调一次
 * `resolveKnowledgeBaseAccess` 判知识库归属并解析 RAGFlow key，然后才把 provider 的入参逐字段拼出来
 * （`kb.remoteAccountId ?? authCtx.userId`、`kb.remoteUserId ?? authCtx.userId` 这类回退也写在协议层）。
 * 同一段「先资源、后知识库」的顺序在 7 条端点上各写一遍，漏掉任何一次前置查询就会失去归属校验。
 *
 * 现在这段编排只在本层出现一次：解析归属（先资源、后知识库）→ 取凭据 → 调 provider 或领域服务 →
 * 把结果收敛成 {@link KnowledgeResult}。协议层只负责表单解析、参数校验与响应映射。
 *
 * 组织边界：知识库端点一律「本组织」；跨组织的知识库与不存在的知识库返回**同一个** `not-found`。
 * 文件/PDF 预览也按当前组织校验知识库归属；资源 ID 与知识库 ID 必须匹配。
 *
 * 远端身份：provider 入参里的 `remoteAccountId` / `remoteUserId` 沿用 `kb.remoteAccountId ?? 调用者`
 * 这一既有回退（空字符串不回退，与 `resolveKnowledgeTenantIdentity` 的裁剪语义不同，故不合并两者）。
 */

import { getKnowledgeProvider } from "../services/knowledge-provider/registry";
import type { KnowledgeProvider } from "../services/knowledge-provider/types";
import {
  deleteKnowledgeResource,
  importKnowledgeResourceFromUrl,
  type KnowledgeResourceDto,
  markKnowledgeResourceProcessing,
  refreshKnowledgeResourceStatus,
  uploadKnowledgeResource,
} from "../services/knowledge-upload";
import type { KnowledgeAccess, KnowledgeBaseActor } from "./knowledge-access";
import { knowledgeAccess } from "./knowledge-access";
import { type KnowledgeResult, knowledgeFail, knowledgeNotFound, knowledgeOk } from "./knowledge-result";

/** 切片列表页；由 provider 的返回类型反推，避免门面与路由各写一份。 */
export type KnowledgeChunkPage = Awaited<ReturnType<KnowledgeProvider["listChunks"]>>;

/** 资源原文件的预览定位；协议层据此决定是流式返回本地文件、302 重定向还是回传远端内容。 */
export type KnowledgeFilePreview =
  | { readonly kind: "local"; readonly path: string; readonly fileName: string }
  | { readonly kind: "redirect"; readonly url: string }
  | {
      readonly kind: "remote";
      readonly content: ReadableStream<Uint8Array>;
      readonly contentType: string;
      readonly fileName: string;
    };

/** 上传/导入动作的选项。 */
export interface UploadKnowledgeResourcesOptions {
  /** 同名资源已存在时允许覆盖（先删远端与本地同名记录再上传）。 */
  readonly overwrite: boolean;
}

/** 切片列表查询参数；分页已由协议层夹紧。 */
export interface KnowledgeChunkQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly keyword?: string;
}

/**
 * 知识资源的应用接口（Facade 的契约面）。
 *
 * 所有方法都返回 {@link KnowledgeResult}：失败要么是 `not-found`（资源/知识库不存在或跨组织不可见），
 * 要么是 `failed`（本地动作失败）或 `upstream`（provider 失败），错误码与文案保持迁移前的对外口径。
 */
export interface KnowledgeResourceFacade {
  /** 上传文件资源；逐个文件独立成败，失败项先删本地残留再按 `overwrite=false` 重试一次。 */
  upload(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    files: File[],
    options: UploadKnowledgeResourcesOptions,
  ): Promise<KnowledgeResult<KnowledgeResourceDto[]>>;
  /** 通过 URL 导入资源；provider 失败不抛错，返回 `status: "error"` 的资源 DTO（协议层映射 502）。 */
  importFromUrl(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    input: { url: string; sourceName?: string },
  ): Promise<KnowledgeResult<KnowledgeResourceDto>>;
  /** 资源列表：先按远端同步，远端不可用时退回本地缓存。 */
  list(actor: KnowledgeBaseActor, knowledgeBaseId: string): Promise<KnowledgeResult<KnowledgeResourceDto[]>>;
  /** 删除资源（含远端文档）；资源不属于该知识库时与不存在同码。 */
  remove(actor: KnowledgeBaseActor, knowledgeBaseId: string, resourceId: string): Promise<KnowledgeResult<null>>;
  /** 启停资源（远端文档可用性）。 */
  setEnabled(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    resourceId: string,
    enabled: boolean,
  ): Promise<KnowledgeResult<{ enabled: boolean }>>;
  /** 触发重新解析；远端已受理后把本地状态置为 processing 供前端轮询。 */
  reparse(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    resourceId: string,
    options: { deleteOld: boolean },
  ): Promise<KnowledgeResult<null>>;
  /** 分页拉取切片；资源或知识库未同步远端时返回空分页（不调用 provider）。 */
  listChunks(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    resourceId: string,
    query: KnowledgeChunkQuery,
  ): Promise<KnowledgeResult<KnowledgeChunkPage>>;
  /** 切换单个切片的启用状态；未关联远端文档时为 `failed`（400 `NO_REMOTE`）。 */
  setChunkEnabled(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    resourceId: string,
    chunkId: string,
    enabled: boolean,
  ): Promise<KnowledgeResult<{ enabled: boolean }>>;
  /**
   * 资源文件预览定位（上传件走本地文件、URL 件走 302、其余尝试远端下载）。
   *
   * 先校验当前组织对知识库的归属，再定位源文件。
   */
  resolveFilePreview(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    resourceId: string,
  ): Promise<KnowledgeResult<KnowledgeFilePreview>>;
  /** Office 转 PDF 的来源定位：只有 upload 类型有本地文件。 */
  resolvePdfSource(
    actor: KnowledgeBaseActor,
    knowledgeBaseId: string,
    resourceId: string,
  ): Promise<KnowledgeResult<{ path: string; fileName: string }>>;
}

/** 错误消息提取：非 Error 上抛时用业务文案兜底（与迁移前的兜底一致）。 */
function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * 迁移前的 404/400 分界就是这句文案判定（协议层 `message.includes("不存在")`）。
 *
 * 保留它是因为 `services/knowledge-upload` 的「知识库 remoteId 不存在」在迁移前同样落到 404：改判成 400
 * 属于协议变更，不在本次上移范围。
 */
function isMissingTargetError(err: unknown): boolean {
  return messageOf(err, "").includes("不存在");
}

/**
 * 构造门面。
 *
 * `access` 是可注入的端口（默认进程级解析器）：归属判定与凭据身份必须可断言，见 `./knowledge-access`。
 */
export function createKnowledgeResourceFacade(access: KnowledgeAccess = knowledgeAccess): KnowledgeResourceFacade {
  return {
    upload: async (actor, knowledgeBaseId, files, options) => {
      // 无文件时不必判定归属：迁移前 `files.map` 不会触达服务，空表单因此总是成功（协议层已过滤非文件项）。
      if (files.length === 0) return knowledgeOk([]);
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      const { kb, credential } = context;
      try {
        const items = await Promise.all(
          files.map((file) => uploadKnowledgeResource(kb, credential, file, options.overwrite)),
        );

        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (item?.status !== "error") continue;
          // 失败项的重试路径：先清掉本次写下的残留（远端 + 本地），再按不覆盖语义重试一次。
          await deleteKnowledgeResource(kb, credential, item.id);
          items[index] = await uploadKnowledgeResource(kb, credential, files[index]!, false);
        }

        const failedItem = items.find((item) => item.status === "error");
        if (failedItem) {
          throw new Error(failedItem.lastError || `${failedItem.sourceName} 上传失败`);
        }
        return knowledgeOk(items);
      } catch (err) {
        console.error(err);
        const message = messageOf(err, "上传知识资源失败");
        if (isMissingTargetError(err)) return knowledgeNotFound(message);
        return knowledgeFail("invalid", "VALIDATION_ERROR", message);
      }
    },

    importFromUrl: async (actor, knowledgeBaseId, input) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      try {
        return knowledgeOk(
          await importKnowledgeResourceFromUrl(context.kb, context.credential, {
            url: input.url,
            sourceName: input.sourceName,
          }),
        );
      } catch (err) {
        console.error(err);
        const message = messageOf(err, "导入知识资源失败");
        if (isMissingTargetError(err)) return knowledgeNotFound(message);
        return knowledgeFail("invalid", "VALIDATION_ERROR", message);
      }
    },

    list: async (actor, knowledgeBaseId) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      return knowledgeOk(await refreshKnowledgeResourceStatus(context.kb, context.credential));
    },

    remove: async (actor, knowledgeBaseId, resourceId) => {
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      try {
        const result = await deleteKnowledgeResource(context.kb, context.credential, resourceId);
        if (!result.success) return knowledgeNotFound(result.error.message);
        return knowledgeOk(null);
      } catch (err) {
        console.error(err);
        return knowledgeFail("failed", "DELETE_FAILED", messageOf(err, "删除资源失败"));
      }
    },

    setEnabled: async (actor, knowledgeBaseId, resourceId, enabled) => {
      const resource = await access.findResourceInBase(knowledgeBaseId, resourceId);
      if (!resource) return knowledgeNotFound("资源不存在");
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      const { kb, credential } = context;
      try {
        const apiKey = await credential();
        await getKnowledgeProvider().setResourceEnabled({
          resourceRemoteId: resource.remoteId!,
          knowledgeBaseRemoteId: kb.remoteId!,
          remoteAccountId: kb.remoteAccountId ?? actor.userId,
          remoteUserId: kb.remoteUserId ?? actor.userId,
          enabled,
          apiKey,
        });
        return knowledgeOk({ enabled });
      } catch (err) {
        console.error(err);
        return knowledgeFail("failed", "TOGGLE_FAILED", messageOf(err, "更新资源状态失败"));
      }
    },

    reparse: async (actor, knowledgeBaseId, resourceId, options) => {
      const resource = await access.findResourceInBase(knowledgeBaseId, resourceId);
      if (!resource) return knowledgeNotFound("资源不存在");
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      const { kb, credential } = context;
      try {
        if (!resource.remoteId || !kb.remoteId) {
          return knowledgeFail("failed", "NOT_SYNCED", "资源尚未同步到远端");
        }
        const apiKey = await credential();
        await getKnowledgeProvider().reparseResource({
          resourceRemoteId: resource.remoteId,
          knowledgeBaseRemoteId: kb.remoteId,
          remoteAccountId: kb.remoteAccountId ?? actor.userId,
          remoteUserId: kb.remoteUserId ?? actor.userId,
          deleteOld: options.deleteOld,
          apiKey,
        });
        await markKnowledgeResourceProcessing(resourceId);
        return knowledgeOk(null);
      } catch (err) {
        console.error(err);
        return knowledgeFail("failed", "REPARSE_FAILED", messageOf(err, "重新解析失败"));
      }
    },

    listChunks: async (actor, knowledgeBaseId, resourceId, query) => {
      const resource = await access.findResourceInBase(knowledgeBaseId, resourceId);
      if (!resource) return knowledgeNotFound("资源不存在");
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      const { kb, credential } = context;
      try {
        if (!resource.remoteId || !kb.remoteId) {
          return knowledgeOk({ items: [], total: 0, page: query.page, pageSize: query.pageSize });
        }
        const apiKey = await credential();
        return knowledgeOk(
          await getKnowledgeProvider().listChunks({
            knowledgeBaseRemoteId: kb.remoteId,
            resourceRemoteId: resource.remoteId,
            remoteAccountId: kb.remoteAccountId ?? actor.userId,
            remoteUserId: kb.remoteUserId ?? actor.userId,
            page: query.page,
            pageSize: query.pageSize,
            keyword: query.keyword,
            apiKey,
          }),
        );
      } catch (err) {
        console.error("Failed to list chunks", err);
        return knowledgeFail("failed", "CHUNK_LIST_FAILED", messageOf(err, "获取切片列表失败"));
      }
    },

    setChunkEnabled: async (actor, knowledgeBaseId, resourceId, chunkId, enabled) => {
      const resource = await access.findResourceInBase(knowledgeBaseId, resourceId);
      if (!resource) return knowledgeNotFound("资源不存在");
      const context = await access.resolveOwnedRemoteBase(actor, knowledgeBaseId);
      if (!context) return knowledgeNotFound("知识库不存在");
      const { kb, credential } = context;
      try {
        if (!resource.remoteId || !kb.remoteId) {
          return knowledgeFail("failed", "NO_REMOTE", "资源未关联远端文档");
        }
        const apiKey = await credential();
        await getKnowledgeProvider().switchChunk({
          knowledgeBaseRemoteId: kb.remoteId,
          resourceRemoteId: resource.remoteId,
          chunkId,
          available: enabled,
          remoteAccountId: kb.remoteAccountId ?? actor.userId,
          remoteUserId: kb.remoteUserId ?? actor.userId,
          apiKey,
        });
        return knowledgeOk({ enabled });
      } catch (err) {
        console.error("Failed to switch chunk", err);
        return knowledgeFail("failed", "CHUNK_SWITCH_FAILED", messageOf(err, "切换切片状态失败"));
      }
    },

    resolveFilePreview: async (actor, knowledgeBaseId, resourceId) => {
      const kb = await access.resolveOwnedBase(actor, knowledgeBaseId);
      if (!kb) return knowledgeNotFound("知识库不存在");
      const resource = await access.findResourceInBase(knowledgeBaseId, resourceId);
      if (!resource) return knowledgeNotFound("资源不存在");

      // upload 类型：返回本地文件路径，由协议层按 MIME 流式返回
      if (resource.sourceType === "upload" && resource.sourcePath) {
        return knowledgeOk({ kind: "local", path: resource.sourcePath, fileName: resource.sourceName });
      }

      // url 类型：重定向到原始 URL
      if (resource.sourceType === "url" && resource.sourcePath) {
        return knowledgeOk({ kind: "redirect", url: resource.sourcePath });
      }

      // 其他非 upload/url 资源（RAGFlow 直接导入等）：通过 RAGFlow API 下载原始文件
      if (resource.remoteId) {
        const context = await access.resolveRemoteFileBase(actor, knowledgeBaseId);
        if (context) {
          try {
            const apiKey = await context.credential();
            const provider = getKnowledgeProvider();
            if (provider.downloadResource) {
              const result = await provider.downloadResource({
                resourceRemoteId: resource.remoteId,
                knowledgeBaseRemoteId: context.kb.remoteId!,
                apiKey,
              });
              if (result) {
                return knowledgeOk({
                  kind: "remote",
                  content: result.content,
                  contentType: result.contentType,
                  fileName: result.fileName,
                });
              }
            }
          } catch (downloadErr) {
            console.error("[knowledge] Failed to download resource from RAGFlow:", downloadErr);
          }
        }
      }

      return knowledgeFail("failed", "NO_LOCAL_FILE", "该资源没有可预览的本地文件");
    },

    resolvePdfSource: async (actor, knowledgeBaseId, resourceId) => {
      const kb = await access.resolveOwnedBase(actor, knowledgeBaseId);
      if (!kb) return knowledgeNotFound("知识库不存在");
      const resource = await access.findResourceInBase(knowledgeBaseId, resourceId);
      if (!resource) return knowledgeNotFound("资源不存在");
      if (resource.sourceType !== "upload" || !resource.sourcePath) {
        return knowledgeFail("failed", "NO_LOCAL_FILE", "该资源没有本地文件");
      }
      return knowledgeOk({ path: resource.sourcePath, fileName: resource.sourceName });
    },
  };
}

/** 进程级无状态实现。 */
export const knowledgeResourceFacade: KnowledgeResourceFacade = createKnowledgeResourceFacade();
