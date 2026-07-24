import { stat } from "node:fs/promises";
import { extname } from "node:path";
import Elysia from "elysia";
import * as z from "zod/v4";
import { authGuardPlugin } from "../../plugins/auth";
import { knowledgeResourceRepo } from "../../repositories/knowledge-base";
import { WebErrSchema, WebOkSchema } from "../../schemas/common.schema";
import {
  CreateKnowledgeBaseRequestSchema,
  ImportKnowledgeUrlRequestSchema,
  ImportKnowledgeUrlResponseSchema,
  KnowledgeBaseDetailResponseSchema,
  KnowledgeBaseInfoSchema,
  KnowledgeBaseListResponseSchema,
  KnowledgeResourceItemSchema,
  KnowledgeResourceListResponseSchema,
  UpdateKnowledgeBaseRequestSchema,
  UploadKnowledgeResourcesResponseSchema,
} from "../../schemas/knowledge.schema";
import {
  createKnowledgeBaseRecord,
  deleteKnowledgeBase,
  getKnowledgeBaseDetail,
  listKnowledgeBasesByTeamId,
  updateKnowledgeBase,
} from "../../services/knowledge-base";
import {
  deleteKnowledgeResource,
  importKnowledgeResourceFromUrl,
  listKnowledgeResources,
  uploadKnowledgeResource,
} from "../../services/knowledge-upload";

/** 文件扩展名 → MIME 类型映射 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".py": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".sh": "text/plain",
  ".bash": "text/plain",
  ".sql": "text/plain",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".m4v": "video/x-m4v",
};

const app = new Elysia({ name: "web-knowledge-bases" }).use(authGuardPlugin).model({
  "knowledge-base-info": KnowledgeBaseInfoSchema,
  "knowledge-base-detail": KnowledgeBaseDetailResponseSchema,
  "knowledge-base-list": KnowledgeBaseListResponseSchema,
  "knowledge-resource-item": KnowledgeResourceItemSchema,
  "knowledge-resource-list": KnowledgeResourceListResponseSchema,
  "create-knowledge-base-request": CreateKnowledgeBaseRequestSchema,
  "update-knowledge-base-request": UpdateKnowledgeBaseRequestSchema,
  "import-knowledge-url-request": ImportKnowledgeUrlRequestSchema,
  "upload-knowledge-resources-response": UploadKnowledgeResourcesResponseSchema,
  "import-knowledge-url-response": ImportKnowledgeUrlResponseSchema,
  "delete-knowledge-base-response": WebOkSchema(z.null()).describe("删除知识库后的成功响应。"),
  "delete-knowledge-resource-response": WebOkSchema(z.null()).describe("删除知识资源后的成功响应。"),
});

app.get(
  "/knowledgeBases",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    return { success: true as const, data: (await listKnowledgeBasesByTeamId(authCtx.organizationId)) as any };
  },
  {
    sessionAuth: true,
    response: "knowledge-base-list",
    detail: {
      tags: ["Knowledge"],
      summary: "获取知识库列表",
      description: "返回当前组织下的知识库列表及其资源统计信息。",
    },
  },
);

app.post(
  "/knowledgeBases",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as {
      name?: string;
      slug?: string;
      description?: string;
      action?: string;
      remoteId?: string;
      embeddingModel?: string | null;
      parseMethod?: "builtin" | "pipeline" | null;
      pipelineId?: string | null;
      chunkMethod?: string | null;
    };

    // Action-based dispatch (list-unassociated, import)
    if (payload.action === "list-unassociated") {
      try {
        const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
        const { config } = await import("../../config");
        const { knowledgeBaseRepo } = await import("../../repositories/knowledge-base");
        const provider = getKnowledgeProvider();
        const datasets = await (provider.listDatasets?.({ apiKey: config.ragflowApiKey }) ?? []);
        // 过滤掉已经本地关联的知识库
        const localRows = await knowledgeBaseRepo.listByOrganizationId(authCtx.organizationId);
        const localRemoteIds = new Set(localRows.map((r) => r.remoteId).filter(Boolean) as string[]);
        const unassociated = datasets.filter((ds) => !localRemoteIds.has(ds.id));
        return { success: true as const, data: unassociated };
      } catch (err) {
        return error(502, {
          success: false,
          error: { code: "PROVIDER_ERROR", message: err instanceof Error ? err.message : "查询失败" },
        });
      }
    }

    if (payload.action === "import") {
      if (!payload.name || !payload.remoteId) {
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "name and remoteId are required" },
        });
      }
      try {
        const { knowledgeBaseRepo } = await import("../../repositories/knowledge-base");
        const { generateKnowledgeBaseSlug } = await import("../../services/knowledge-base");
        // 防重复
        const allRows = await knowledgeBaseRepo.listByOrganizationId(authCtx.organizationId);
        const existingRemoteIds = new Set(allRows.map((r) => r.remoteId).filter(Boolean) as string[]);
        if (existingRemoteIds.has(payload.remoteId)) {
          return error(409, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "该知识库已在当前范围中关联，无需重复导入" },
          });
        }
        const slug = generateKnowledgeBaseSlug(payload.name);
        const now = new Date();
        const row = await knowledgeBaseRepo.create({
          userId: authCtx.userId,
          organizationId: authCtx.organizationId,
          name: payload.name.trim(),
          slug,
          provider: "ragflow",
          remoteId: payload.remoteId,
          remoteAccountId: authCtx.userId,
          remoteUserId: authCtx.userId,
          status: "empty",
          createdAt: now,
          updatedAt: now,
        });
        const data = {
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description ?? null,
          provider: row.provider,
          remoteId: row.remoteId ?? null,
          remoteAccountId: row.remoteAccountId ?? null,
          remoteUserId: row.remoteUserId ?? null,
          status: row.status,
          lastError: row.lastError ?? null,
          bindingsCount: 0,
          resourcesCount: 0,
          embeddingModel: row.embeddingModel ?? null,
          parseMethod: row.parseMethod ?? null,
          chunkMethod: row.chunkMethod ?? null,
          createdAt: Math.floor(row.createdAt.getTime() / 1000),
          updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
          userId: row.userId,
          organizationId: row.organizationId,
          recentResources: [],
        };
        return { success: true as const, data };
      } catch (err) {
        return error(502, {
          success: false,
          error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: err instanceof Error ? err.message : "导入失败" },
        });
      }
    }

    // Default: create knowledge base
    if (!payload.name) {
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name is required" } });
    }
    try {
      const result = await createKnowledgeBaseRecord(
        authCtx.organizationId,
        {
          name: payload.name,
          slug: payload.slug,
          description: payload.description,
          embeddingModel: payload.embeddingModel,
          parseMethod: payload.parseMethod,
          pipelineId: payload.pipelineId,
          chunkMethod: payload.chunkMethod,
        },
        authCtx.userId,
      );
      if (!result.success) {
        return error(400, { success: false, error: { code: result.error.code, message: result.error.message } });
      }
      return { success: true as const, data: result.data };
    } catch (err) {
      console.error(err);
      return error(502, {
        success: false,
        error: {
          code: "KNOWLEDGE_PROVIDER_ERROR",
          message: err instanceof Error ? err.message : "知识库上游服务异常",
        },
      });
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Knowledge"],
      summary: "创建知识库",
      description: "创建一个新的知识库记录，并初始化远端知识库信息。",
    },
  },
);

// Must be before /:id route to avoid "form-options" being treated as an id
app.get(
  "/knowledgeBases/form-options",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async (_ctx: any) => {
    try {
      const { config } = await import("../../config");
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const { KNOWLEDGE_CHUNK_METHODS } = await import("../../services/knowledge-base");
      const provider = getKnowledgeProvider();
      const embResult = provider.listEmbeddingModels?.(config.ragflowApiKey);
      const pipResult = provider.listPipelines?.(config.ragflowApiKey);
      const [embeddingModels, pipelines] = await Promise.all([
        embResult instanceof Promise ? embResult.catch(() => []) : (embResult ?? []),
        pipResult instanceof Promise ? pipResult.catch(() => []) : (pipResult ?? []),
      ]);
      return {
        success: true as const,
        data: {
          embeddingModels: embeddingModels || [],
          chunkMethods: KNOWLEDGE_CHUNK_METHODS,
          pipelines: pipelines || [],
        },
      };
    } catch (_err) {
      return { success: true as const, data: { embeddingModels: [], chunkMethods: [], pipelines: [] } };
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "获取创建表单可选项" } },
);

app.get(
  "/knowledgeBases/rerank-models",
  async () => {
    try {
      const { config } = await import("../../config");
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const provider = getKnowledgeProvider();
      const models = (await provider.listRerankModels?.(config.ragflowApiKey)) ?? [];
      return { success: true as const, data: models };
    } catch {
      return { success: true as const, data: [] };
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "获取 rerank 模型列表" } },
);

// ===== 检索测试 =====
app.post(
  "/knowledgeBases/:id/search",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body }: any) => {
    const { id } = params;
    const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
    const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
    const authCtx = store.authContext!;
    const kb = await getKnowledgeBaseDetail(authCtx.organizationId, id);
    if (!kb) return { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } };
    const provider = getKnowledgeProvider();
    const { query, similarityThreshold, vectorSimilarityWeight, topK, pageSize, rerankId, keyword, highlight } = body;
    try {
      const results = await provider.searchDetailed!({
        knowledgeBases: [
          { remoteId: kb.remoteId!, remoteAccountId: kb.remoteAccountId!, remoteUserId: kb.remoteUserId! },
        ],
        query: query || "",
        similarityThreshold: similarityThreshold ?? 0.2,
        vectorSimilarityWeight: vectorSimilarityWeight ?? 0.5,
        topK: topK ?? 10,
        pageSize: pageSize ?? 10,
        rerankId: rerankId ?? null,
        keyword: keyword ?? false,
        highlight: highlight ?? false,
      });
      return { success: true as const, data: results };
    } catch (err) {
      console.error("[knowledge-bases] search failed", err);
      return {
        success: false,
        error: { code: "SEARCH_ERROR", message: err instanceof Error ? err.message : "检索失败" },
      };
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "知识库检索测试" } },
);

app.get(
  "/knowledgeBases/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const detail = await getKnowledgeBaseDetail(authCtx.organizationId, id);
    if (!detail) {
      return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
    }
    return { success: true as const, data: detail };
  },
  {
    sessionAuth: true,
    response: {
      200: "knowledge-base-detail",
      404: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "获取知识库详情",
      description: "根据知识库 ID 返回知识库详情及最近的资源列表。",
    },
  },
);

app.patch(
  "/knowledgeBases/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const payload = body as { name?: string; slug?: string; description?: string };
    const result = await updateKnowledgeBase(authCtx.organizationId, id, {
      name: payload.name,
      slug: payload.slug,
      description: payload.description,
    });
    if (!result.success) {
      const status = result.error.code === "NOT_FOUND" ? 404 : 400;
      return error(status, { success: false, error: { code: result.error.code, message: result.error.message } });
    }
    return { success: true as const, data: result.data };
  },
  {
    sessionAuth: true,
    body: "update-knowledge-base-request",
    response: {
      200: WebOkSchema(KnowledgeBaseInfoSchema),
      400: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "更新知识库",
      description: "更新知识库名称、slug 或描述信息。",
    },
  },
);

app.delete(
  "/knowledgeBases/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    try {
      const result = await deleteKnowledgeBase(authCtx.organizationId, id);
      if (!result.success) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: result.error.message } });
      }
      return { success: true as const, data: null };
    } catch (err) {
      console.error(err);
      return error(400, {
        success: false,
        error: {
          code: "DELETE_FAILED",
          message: err instanceof Error ? err.message : "删除知识库失败",
        },
      });
    }
  },
  {
    sessionAuth: true,
    response: {
      200: "delete-knowledge-base-response",
      400: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "删除知识库",
      description: "删除指定知识库及其关联资源绑定。",
    },
  },
);

app.post(
  "/knowledgeBases/:id/resources/upload",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 multipart/response 组合下类型推断不稳定
  async ({ store, params, request, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    try {
      const form = await request.formData();
      const files = Array.from(form.getAll("files")).filter(
        (entry: unknown): entry is globalThis.File => entry instanceof globalThis.File,
      );
      const items = await Promise.all(
        files.map((file) => uploadKnowledgeResource(authCtx.organizationId, id, file as unknown as File)),
      );

      for (let index = 0; index < items.length; index += 1) {
        if (items[index]?.status !== "error") {
          continue;
        }
        await deleteKnowledgeResource(authCtx.organizationId, id, items[index]!.id);
        items[index] = await uploadKnowledgeResource(authCtx.organizationId, id, files[index]! as unknown as File);
      }

      const failedItem = items.find((item) => item.status === "error");
      if (failedItem) {
        throw new Error(failedItem.lastError || `${failedItem.sourceName} 上传失败`);
      }
      return { success: true as const, data: { items } };
    } catch (err) {
      console.error(err);
      const message = (err as Error).message;
      const status = message.includes("不存在") ? 404 : 400;
      return error(status, {
        success: false,
        error: { code: status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", message },
      });
    }
  },
  {
    sessionAuth: true,
    response: {
      200: "upload-knowledge-resources-response",
      400: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "上传知识资源",
      description: "向指定知识库上传一个或多个文件资源，并返回本次处理后的资源列表。",
    },
  },
);

app.post(
  "/knowledgeBases/:id/resources/url",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const payload = body as { url: string; sourceName?: string };
    if (!payload.url || typeof payload.url !== "string") {
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "url 为必填字段" } });
    }
    try {
      const item = await importKnowledgeResourceFromUrl(authCtx.organizationId, id, {
        url: payload.url,
        sourceName: payload.sourceName,
      });
      const status = item.status === "error" ? 502 : 201;
      if (status >= 400) return error(status, item);
      return { success: true as const, data: item };
    } catch (err) {
      console.error(err);
      const message = (err as Error).message;
      const status = message.includes("不存在") ? 404 : 400;
      return error(status, {
        success: false,
        error: { code: status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", message },
      });
    }
  },
  {
    sessionAuth: true,
    body: "import-knowledge-url-request",
    response: {
      200: "import-knowledge-url-response",
      201: "import-knowledge-url-response",
      400: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "通过 URL 导入资源",
      description: "从指定 URL 拉取内容并导入到知识库，返回创建后的资源记录。",
    },
  },
);

app.get(
  "/knowledgeBases/:id/resources",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const items = await listKnowledgeResources(authCtx.organizationId, id);
    if (!items) {
      return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
    }
    return { success: true as const, data: items };
  },
  {
    sessionAuth: true,
    response: {
      200: "knowledge-resource-list",
      404: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "获取知识资源列表",
      description: "返回指定知识库下的全部知识资源记录。",
    },
  },
);

app.delete(
  "/knowledgeBases/:id/resources/:resourceId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const resourceId = params.resourceId;
    try {
      const result = await deleteKnowledgeResource(authCtx.organizationId, id, resourceId);
      if (!result.success) {
        return error(404, { success: false, error: { code: result.error.code, message: result.error.message } });
      }
      return { success: true as const, data: null };
    } catch (err) {
      console.error(err);
      return error(400, {
        success: false,
        error: {
          code: "DELETE_FAILED",
          message: err instanceof Error ? err.message : "删除资源失败",
        },
      });
    }
  },
  {
    sessionAuth: true,
    response: {
      200: "delete-knowledge-resource-response",
      400: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "删除知识资源",
      description: "删除指定知识库下的单个资源记录及其远端资源。",
    },
  },
);

// 资源启用/禁用开关
app.patch(
  "/knowledgeBases/:id/resources/:resourceId/enabled",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const { id, resourceId } = params;
    const enabled = body?.enabled === true || body?.enabled === "true" || body?.enabled === 1;
    try {
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const { getKnowledgeBaseDetail, listKnowledgeBaseResources } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(authCtx.organizationId, id);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });

      // 通过本地 resourceId 查找对应的 remoteId
      const localResources = await listKnowledgeBaseResources(id);
      const local = localResources.find((r) => r.id === resourceId);
      const resourceRemoteId = local?.remoteId;
      if (!resourceRemoteId) {
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "资源尚未同步到远端，无法切换" },
        });
      }

      const provider = getKnowledgeProvider();
      await provider.setResourceEnabled!({
        remoteAccountId: "",
        remoteUserId: "",
        resourceRemoteId,
        knowledgeBaseRemoteId: kb.remoteId!,
        enabled,
      });
      return { success: true as const, data: { enabled } };
    } catch (err) {
      console.error(err);
      return error(400, {
        success: false,
        error: { code: "TOGGLE_FAILED", message: err instanceof Error ? err.message : "切换失败" },
      });
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "切换资源启用状态" } },
);

// 资源重新解析
app.post(
  "/knowledgeBases/:id/resources/:resourceId/reparse",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const { id, resourceId } = params;
    const deleteOld = body?.delete === true;
    try {
      const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
      const { knowledgeResourceRepo } = await import("../../repositories/knowledge-base");
      const { upsertKnowledgeBaseStatusFromResources } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(authCtx.organizationId, id);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      // 通过本地 resourceId 查找 remoteId
      const resource = await knowledgeResourceRepo.getById(resourceId);
      if (!resource || resource.knowledgeBaseId !== id) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
      }
      if (!resource.remoteId || !kb.remoteId) {
        return error(400, { success: false, error: { code: "NOT_SYNCED", message: "资源尚未同步到远端" } });
      }
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const provider = getKnowledgeProvider();
      await provider.reparseResource!({
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
        deleteOld,
        resourceRemoteId: resource.remoteId,
        knowledgeBaseRemoteId: kb.remoteId,
      });
      // 更新本地状态为 processing，并刷新知识库状态为 indexing
      await knowledgeResourceRepo.update(resourceId, { status: "processing", updatedAt: new Date() });
      await upsertKnowledgeBaseStatusFromResources(id);
      return { success: true as const, data: null };
    } catch (err) {
      console.error(err);
      return error(400, {
        success: false,
        error: { code: "REPARSE_FAILED", message: err instanceof Error ? err.message : "重新解析失败" },
      });
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "重新解析资源" } },
);

// ===== Embedding 模型管理 =====

app.post(
  "/knowledgeBases/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ body }: any) => {
    const payload = body as {
      action: string;
      provider?: string;
      providerApiKey?: string;
      baseUrl?: string | null;
      instanceName?: string;
      modelName?: string;
      status?: "active" | "inactive";
    };

    try {
      switch (payload.action) {
        case "list": {
          const { listConfiguredProviderTree } = await import("../../services/knowledge-base");
          const data = await listConfiguredProviderTree();
          return { success: true as const, data };
        }
        case "list-factories": {
          const { listEmbeddingFactories } = await import("../../services/knowledge-base");
          const data = await listEmbeddingFactories();
          return { success: true as const, data };
        }
        case "verify": {
          if (!payload.provider || !payload.providerApiKey) {
            return { success: false, error: { code: "VALIDATION_ERROR", message: "provider 和 providerApiKey 必填" } };
          }
          const { verifyEmbeddingProvider } = await import("../../services/knowledge-base");
          const data = await verifyEmbeddingProvider({
            provider: payload.provider,
            providerApiKey: payload.providerApiKey,
            baseUrl: payload.baseUrl,
          });
          return { success: true as const, data };
        }
        case "list-provider-models": {
          if (!payload.provider || !payload.providerApiKey) {
            return { success: false, error: { code: "VALIDATION_ERROR", message: "provider 和 providerApiKey 必填" } };
          }
          const { listProviderEmbeddingModels } = await import("../../services/knowledge-base");
          const data = await listProviderEmbeddingModels({
            provider: payload.provider,
            providerApiKey: payload.providerApiKey,
            baseUrl: payload.baseUrl,
          });
          return { success: true as const, data };
        }
        case "list-instance-models": {
          if (!payload.provider || !payload.instanceName) {
            return { success: false, error: { code: "VALIDATION_ERROR", message: "provider 和 instanceName 必填" } };
          }
          const { listInstanceEmbeddingModels } = await import("../../services/knowledge-base");
          const data = await listInstanceEmbeddingModels({
            provider: payload.provider,
            instanceName: payload.instanceName,
          });
          return { success: true as const, data };
        }
        case "set-model-status": {
          if (!payload.provider || !payload.instanceName || !payload.modelName || !payload.status) {
            return {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider/instanceName/modelName/status 必填" },
            };
          }
          const { setEmbeddingModelStatus } = await import("../../services/knowledge-base");
          await setEmbeddingModelStatus({
            provider: payload.provider,
            instanceName: payload.instanceName,
            modelName: payload.modelName,
            status: payload.status,
          });
          return { success: true as const, data: { ok: true } };
        }
        case "add": {
          if (!payload.provider || !payload.instanceName || !payload.providerApiKey) {
            return {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider/instanceName/providerApiKey 必填" },
            };
          }
          const { addEmbeddingProvider } = await import("../../services/knowledge-base");
          const data = await addEmbeddingProvider({
            provider: payload.provider,
            instanceName: payload.instanceName,
            providerApiKey: payload.providerApiKey,
            baseUrl: payload.baseUrl,
          });
          return { success: true as const, data };
        }
        case "delete": {
          if (!payload.provider || !payload.instanceName) {
            return { success: false, error: { code: "VALIDATION_ERROR", message: "provider 和 instanceName 必填" } };
          }
          const { deleteEmbeddingInstance } = await import("../../services/knowledge-base");
          await deleteEmbeddingInstance({
            provider: payload.provider,
            instanceName: payload.instanceName,
          });
          return { success: true as const, data: { ok: true } };
        }
        default:
          return { success: false, error: { code: "VALIDATION_ERROR", message: `unknown action: ${payload.action}` } };
      }
    } catch (err) {
      console.error("[embedding-models] action failed:", err);
      return {
        success: false,
        error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: err instanceof Error ? err.message : "操作失败" },
      };
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Knowledge"],
      summary: "Embedding 模型管理（action 分发）",
      description:
        "管理 RAGFlow 租户下的向量模型。action 取值：list / list-factories / verify / list-provider-models / list-instance-models / add / delete / set-model-status。",
    },
  },
);

// ===== 知识图谱 =====
app.post(
  "/knowledgeBases/:id/graph/generate",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(authCtx.organizationId, params.id);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      if (!kb.remoteId)
        return error(400, { success: false, error: { code: "NO_REMOTE", message: "知识库未关联远端" } });
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      await getKnowledgeProvider().generateKnowledgeGraph!({
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
      });
      return { success: true as const, data: { status: "started" } };
    } catch (err) {
      console.error("[graph] generate failed:", err);
      return error(400, { success: false, error: { code: "GRAPH_ERROR", message: (err as Error).message } });
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "生成知识图谱" } },
);

app.get(
  "/knowledgeBases/:id/graph",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(authCtx.organizationId, params.id);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      if (!kb.remoteId) return { success: true as const, data: null };
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const data = await getKnowledgeProvider().getKnowledgeGraph!({
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
      });
      return { success: true as const, data };
    } catch (err) {
      console.error("[graph] get failed:", err);
      return { success: true as const, data: null };
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "获取知识图谱" } },
);

app.delete(
  "/knowledgeBases/:id/graph",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(authCtx.organizationId, params.id);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      if (!kb.remoteId) return { success: true as const, data: { ok: true } };
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      await getKnowledgeProvider().deleteKnowledgeGraph!({
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
      });
      return { success: true as const, data: { ok: true } };
    } catch (err) {
      console.error("[graph] delete failed:", err);
      return { success: true as const, data: { ok: true } };
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "删除知识图谱" } },
);

app.get(
  "/knowledgeBases/:id/graph/progress",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(authCtx.organizationId, params.id);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      if (!kb.remoteId) return { success: true as const, data: { progress: 0 } };
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const result = await getKnowledgeProvider().pollKnowledgeGraphProgress!({
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
      });
      return { success: true as const, data: result };
    } catch (err) {
      console.error("[graph] progress failed:", err);
      return { success: true as const, data: { progress: 0 } };
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "获取图谱构建进度" } },
);

// ===== 文件下载/预览 =====
app.get(
  "/knowledgeBases/:id/resources/:resourceId/file",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, error }: any) => {
    const resourceId = params.resourceId;
    const kbId = params.id;

    const resource = await knowledgeResourceRepo.getById(resourceId);
    if (!resource || resource.knowledgeBaseId !== kbId) {
      return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
    }

    // upload 类型：直接返回本地文件
    if (resource.sourceType === "upload" && resource.sourcePath) {
      try {
        const fileInfo = await stat(resource.sourcePath);
        if (!fileInfo.isFile()) {
          return error(404, { success: false, error: { code: "FILE_NOT_FOUND", message: "源文件不存在" } });
        }
        const ext = extname(resource.sourceName).toLowerCase();
        const mimeType = MIME_TYPES[ext] || "application/octet-stream";
        const file = Bun.file(resource.sourcePath);
        return new Response(file.stream(), {
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(fileInfo.size),
            "Content-Disposition": `inline; filename="${encodeURIComponent(resource.sourceName)}"`,
          },
        });
      } catch (err) {
        console.error("Failed to serve knowledge resource file", err);
        return error(404, { success: false, error: { code: "FILE_NOT_FOUND", message: "源文件不存在或无法读取" } });
      }
    }

    // url 类型：重定向到原始 URL
    if (resource.sourceType === "url" && resource.sourcePath) {
      return new Response(null, { status: 302, headers: { Location: resource.sourcePath } });
    }

    // 其他非 upload/url 资源：通过 RAGFlow API 下载原始文件
    if (resource.remoteId) {
      const { knowledgeBaseRepo } = await import("../../repositories/knowledge-base");
      const kb = await knowledgeBaseRepo.getById(kbId);
      if (kb?.remoteId) {
        try {
          const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
          const provider = getKnowledgeProvider();
          if (provider.downloadResource) {
            const result = await provider.downloadResource({
              resourceRemoteId: resource.remoteId,
              knowledgeBaseRemoteId: kb.remoteId,
            });
            if (result) {
              return new Response(result.content, {
                headers: {
                  "Content-Type": result.contentType,
                  "Content-Disposition": `inline; filename="${encodeURIComponent(result.fileName)}"`,
                },
              });
            }
          }
        } catch (downloadErr) {
          console.error("[knowledge] Failed to download resource from RAGFlow:", downloadErr);
        }
      }
    }

    return error(400, { success: false, error: { code: "NO_LOCAL_FILE", message: "该资源没有可预览的本地文件" } });
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "获取知识资源文件" } },
);

// ===== 分页查询资源切片列表 =====
app.get(
  "/knowledgeBases/:id/resources/:resourceId/chunks",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, query, error }: any) => {
    const kbId = params.id;
    const resourceId = params.resourceId;
    const page = Math.max(1, Number(query?.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query?.pageSize) || 20));
    const keyword = query?.keyword?.trim() || undefined;

    try {
      const resource = await knowledgeResourceRepo.getById(resourceId);
      if (!resource || resource.knowledgeBaseId !== kbId) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
      }
      const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(store.authContext!.organizationId, kbId);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      if (!resource.remoteId || !kb.remoteId) {
        return { success: true as const, data: { items: [], total: 0, page, pageSize } };
      }
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const provider = getKnowledgeProvider();
      const result = await provider.listChunks({
        knowledgeBaseRemoteId: kb.remoteId,
        resourceRemoteId: resource.remoteId,
        remoteAccountId: kb.remoteAccountId ?? store.authContext!.userId,
        remoteUserId: kb.remoteUserId ?? store.authContext!.userId,
        page,
        pageSize,
        keyword,
      });
      return { success: true as const, data: result };
    } catch (err) {
      console.error("Failed to list chunks", err);
      return error(400, {
        success: false,
        error: { code: "CHUNK_LIST_FAILED", message: err instanceof Error ? err.message : "获取切片列表失败" },
      });
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "分页获取资源切片列表" } },
);

// ===== 切换单个切片启用/禁用 =====
app.patch(
  "/knowledgeBases/:id/resources/:resourceId/chunks/:chunkId/enabled",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, error }: any) => {
    const kbId = params.id;
    const resourceId = params.resourceId;
    const chunkId = params.chunkId;
    const enabled = Boolean(body?.enabled);

    try {
      const resource = await knowledgeResourceRepo.getById(resourceId);
      if (!resource || resource.knowledgeBaseId !== kbId) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
      }
      const { getKnowledgeBaseDetail } = await import("../../services/knowledge-base");
      const kb = await getKnowledgeBaseDetail(store.authContext!.organizationId, kbId);
      if (!kb) return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      if (!resource.remoteId || !kb.remoteId) {
        return error(400, { success: false, error: { code: "NO_REMOTE", message: "资源未关联远端文档" } });
      }
      const { getKnowledgeProvider } = await import("../../services/knowledge-provider/registry");
      const provider = getKnowledgeProvider();
      await provider.switchChunk({
        knowledgeBaseRemoteId: kb.remoteId,
        resourceRemoteId: resource.remoteId,
        chunkId,
        available: enabled,
        remoteAccountId: kb.remoteAccountId ?? store.authContext!.userId,
        remoteUserId: kb.remoteUserId ?? store.authContext!.userId,
      });
      return { success: true as const, data: { enabled } };
    } catch (err) {
      console.error("Failed to switch chunk", err);
      return error(400, {
        success: false,
        error: { code: "CHUNK_SWITCH_FAILED", message: err instanceof Error ? err.message : "切换切片状态失败" },
      });
    }
  },
  { sessionAuth: true, detail: { tags: ["Knowledge"], summary: "切换切片启用状态" } },
);

export default app;
