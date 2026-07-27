import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import Elysia from "elysia";
import * as z from "zod/v4";
import { authGuardPlugin } from "../../plugins/auth";
import { knowledgeBaseRepo, knowledgeResourceRepo } from "../../repositories/knowledge-base";
import { WebErrSchema, WebOkSchema } from "../../schemas/common.schema";
import {
  CreateKnowledgeBaseRequestSchema,
  ImportKnowledgeUrlRequestSchema,
  ImportKnowledgeUrlResponseSchema,
  KnowledgeBaseDetailResponseSchema,
  KnowledgeBaseInfoSchema,
  KnowledgeBaseListResponseSchema,
  KnowledgeFormOptionsResponseSchema,
  KnowledgeFormOptionsSchema,
  KnowledgeResourceItemSchema,
  KnowledgeResourceListResponseSchema,
  KnowledgeSearchBodySchema,
  KnowledgeSearchResponseSchema,
  RerankModelsResponseSchema,
  UpdateKnowledgeBaseRequestSchema,
  UploadKnowledgeResourcesResponseSchema,
} from "../../schemas/knowledge.schema";
import {
  addEmbeddingProvider,
  createKnowledgeBaseRecord,
  deleteEmbeddingInstance,
  deleteKnowledgeBase,
  generateKnowledgeBaseSlug,
  getKnowledgeBaseDetail,
  listConfiguredProviderTree,
  listEmbeddingFactories,
  listInstanceEmbeddingModels,
  listKnowledgeBases,
  listKnowledgeBasesByTeamId,
  listKnowledgeFormOptions,
  listProviderEmbeddingModels,
  sanitizeKnowledgeBase,
  setEmbeddingModelStatus,
  updateKnowledgeBase,
  upsertKnowledgeBaseStatusFromResources,
  verifyEmbeddingProvider,
} from "../../services/knowledge-base";
import { getKnowledgeProvider } from "../../services/knowledge-provider/registry";
import {
  deleteKnowledgeGraphForKb,
  generateKnowledgeGraphForKb,
  getKnowledgeGraphForKb,
  listRerankModelsForOrg,
  pollKnowledgeGraphProgressForKb,
  searchKnowledgeForTest,
} from "../../services/knowledge-runtime";
import {
  deleteKnowledgeResource,
  importKnowledgeResourceFromUrl,
  refreshKnowledgeResourceStatus,
  uploadKnowledgeResource,
} from "../../services/knowledge-upload";
import { createNotification } from "../../services/notification";
import { resolveRagflowApiKey } from "../../services/ragflow-key";

/**
 * 获取知识库并校验访问权限（支持全局 KB 跨组织访问）。
 * 同时解析该知识库对应的 RAGFlow API key。
 */
async function resolveKbWithApiKey(
  kbId: string,
  organizationId: string,
  userId: string,
): Promise<{ kb: NonNullable<Awaited<ReturnType<typeof knowledgeBaseRepo.getById>>>; apiKey: string } | null> {
  const kb = await knowledgeBaseRepo.getById(kbId);
  if (!kb) return null;
  if (kb.organizationId !== organizationId) return null;
  const apiKey = await resolveRagflowApiKey("global", userId, organizationId);
  return { kb, apiKey };
}

/** 文件扩展名 → MIME 类型映射，用于资源文件预览时设置正确的 Content-Type */
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
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  // —— 视频格式 ——
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
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  // —— 补充图片格式 ——
  ".avif": "image/avif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

/** 可转换为 PDF 的 Office 文件扩展名 */
const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

/** Gotenberg 服务地址（Docker: docker run -d -p 3000:3000 gotenberg/gotenberg:8） */
const GOTENBERG_URL = process.env.GOTENBERG_URL || "http://127.0.0.1:3200";

/** PDF 转换缓存目录 */
const PDF_CACHE_DIR = join(process.cwd(), "data/knowledge-pdf-cache");

/**
 * 将 Office 文件转换为 PDF 并返回 PDF 文件路径。
 * 优先级：Gotenberg (Docker HTTP API) → LibreOffice CLI → null。
 * 结果缓存在 PDF_CACHE_DIR 中，转换失败时返回 null。
 */
async function convertToPdf(sourcePath: string, sourceName: string, resourceId: string): Promise<string | null> {
  await mkdir(PDF_CACHE_DIR, { recursive: true });
  const outputPdf = join(PDF_CACHE_DIR, `${resourceId}.pdf`);

  // 缓存命中：PDF 已存在且比源文件新
  if (existsSync(outputPdf)) {
    try {
      const [pdfStat, srcStat] = await Promise.all([stat(outputPdf), stat(sourcePath)]);
      if (pdfStat.mtime >= srcStat.mtime) {
        return outputPdf;
      }
    } catch {
      // 状态检查失败，重新转换
    }
  }

  // — 方式 1：Gotenberg Docker 服务 —
  try {
    const fileBuffer = await import("node:fs/promises").then((m) => m.readFile(sourcePath));
    const formData = new FormData();
    formData.append("files", new Blob([fileBuffer]), sourceName);

    const resp = await fetch(`${GOTENBERG_URL}/forms/libreoffice/convert`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (resp.ok) {
      const pdfBuffer = Buffer.from(await resp.arrayBuffer());
      await writeFile(outputPdf, pdfBuffer);
      return outputPdf;
    }
    console.warn("Gotenberg conversion returned non-OK", { status: resp.status, sourceName });
  } catch {
    console.warn("Gotenberg not available, trying LibreOffice CLI", { sourceName });
  }

  // — 方式 2：LibreOffice CLI 本地命令 —
  for (const cmd of ["libreoffice", "soffice"]) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          cmd,
          ["--headless", "--convert-to", "pdf", "--outdir", PDF_CACHE_DIR, sourcePath],
          { timeout: 60000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      // LibreOffice 生成的 PDF 文件名基于源文件名，需要重命名为缓存 key
      const generatedName = sourceName.replace(extname(sourceName), ".pdf");
      const generatedPath = join(PDF_CACHE_DIR, generatedName);
      if (existsSync(generatedPath) && generatedPath !== outputPdf) {
        const { rename } = await import("node:fs/promises");
        await rename(generatedPath, outputPdf);
      }

      if (existsSync(outputPdf)) {
        return outputPdf;
      }
    } catch {
      // 当前命令不可用，尝试下一个
    }
  }

  console.warn("All PDF conversion methods unavailable", { sourceName, resourceId });
  return null;
}

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
  "knowledge-form-options": KnowledgeFormOptionsSchema,
  "knowledge-form-options-response": KnowledgeFormOptionsResponseSchema,
  "knowledge-search-body": KnowledgeSearchBodySchema,
  "knowledge-search-response": KnowledgeSearchResponseSchema,
  "rerank-models-response": RerankModelsResponseSchema,
  "delete-knowledge-base-response": WebOkSchema(z.null()).describe("删除知识库后的成功响应。"),
  "delete-knowledge-resource-response": WebOkSchema(z.null()).describe("删除知识资源后的成功响应。"),
});

app.get(
  "/knowledgeBases",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    return { success: true as const, data: await listKnowledgeBases(authCtx.organizationId, authCtx.userId) };
  },
  {
    sessionAuth: true,
    response: "knowledge-base-list",
    detail: {
      tags: ["Knowledge"],
      summary: "获取知识库列表",
      description: "返回知识库列表及资源统计信息。",
    },
  },
);

app.post(
  "/knowledgeBases",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as {
      action?: string;
      name?: string;
      slug?: string;
      description?: string;
      embeddingModel?: string | null;
      parseMethod?: "builtin" | "pipeline" | null;
      pipelineId?: string | null;
      chunkMethod?: string | null;
      remoteId?: string;
    };

    // 处理非创建类 action
    if (payload.action === "list-unassociated") {
      try {
        const apiKey = await resolveRagflowApiKey("global", authCtx.userId, authCtx.organizationId);
        const provider = getKnowledgeProvider();
        const datasets = await provider.listDatasets({ apiKey });
        const rows = await knowledgeBaseRepo.listByOrganizationId(authCtx.organizationId);
        const localRemoteIds = new Set(rows.map((r) => r.remoteId).filter(Boolean) as string[]);
        const unassociated = datasets.filter((ds: { id: string }) => !localRemoteIds.has(ds.id));
        return { success: true, data: unassociated };
      } catch (err) {
        return error(502, {
          success: false,
          error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: (err as Error).message },
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
        const orgRows = await knowledgeBaseRepo.listByOrganizationId(authCtx.organizationId);
        const existingIds = new Set(orgRows.map((r) => r.remoteId).filter(Boolean) as string[]);
        if (existingIds.has(payload.remoteId)) {
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
        try {
          const apiKey = await resolveRagflowApiKey("global", authCtx.userId, authCtx.organizationId);
          const provider = getKnowledgeProvider();
          if (provider.getDataset) {
            const dsDetail = await provider.getDataset({ datasetId: payload.remoteId, apiKey });
            if (dsDetail) {
              await knowledgeBaseRepo.update(row.id, {
                updatedAt: new Date(),
                embeddingModel: dsDetail.embeddingModel ?? null,
                parseMethod: dsDetail.parseMethod ?? null,
                chunkMethod: dsDetail.chunkMethod ?? null,
              });
            }
          }
          const remoteResources = await provider.listResources({
            knowledgeBaseRemoteId: payload.remoteId,
            remoteAccountId: authCtx.userId,
            remoteUserId: authCtx.userId,
            apiKey,
          });
          if (remoteResources.length > 0) {
            for (const r of remoteResources) {
              await knowledgeResourceRepo.create({
                knowledgeBaseId: row.id,
                sourceType: r.sourceType,
                sourceName: r.sourceName,
                sourcePath: r.source ?? null,
                remoteId: r.remoteId,
                status: r.status,
                lastError: r.lastError ?? null,
                createdAt: now,
                updatedAt: now,
              });
            }
            await upsertKnowledgeBaseStatusFromResources(row.id);
          }
        } catch (syncErr) {
          console.error("[knowledge] import resource sync failed:", syncErr);
        }
        const detail = await getKnowledgeBaseDetail(authCtx.organizationId, row.id);
        return { success: true, data: detail ?? sanitizeKnowledgeBase(row) };
      } catch (err) {
        return error(502, {
          success: false,
          error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: (err as Error).message },
        });
      }
    }

    // 默认：创建知识库
    if (!payload.name) {
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name is required" } });
    }
    let apiKey: string;
    try {
      apiKey = await resolveRagflowApiKey("global", authCtx.userId, authCtx.organizationId);
    } catch (apiErr) {
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: (apiErr as Error).message } });
    }
    try {
      const result = await createKnowledgeBaseRecord(
        authCtx.organizationId,
        {
          name: payload.name!,
          slug: payload.slug,
          description: payload.description,
          embeddingModel: payload.embeddingModel,
          parseMethod: payload.parseMethod,
          pipelineId: payload.pipelineId,
          chunkMethod: payload.chunkMethod,
          apiKey,
        },
        authCtx.userId,
      );
      if (!result.success)
        return error(400, { success: false, error: { code: result.error.code, message: result.error.message } });
      const kbData = result.data;
      const kbName = payload.name!;
      createNotification({
        type: "knowledge",
        subType: "kb_created",
        title: `知识库「${kbName}」已创建完成`,
        content: `知识库「${kbName}」已成功创建，可以开始上传文档`,
        targetUrl: `/knowledge/bases/${kbData.id}`,
        metadata: { kbId: kbData.id, kbName },
        userId: authCtx.userId,
        organizationId: authCtx.organizationId,
      }).catch((err: unknown) => console.error("[notification] kb create failed:", err));
      return { success: true as const, data: result.data };
    } catch (err) {
      console.error(err);
      return error(502, {
        success: false,
        error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: err instanceof Error ? err.message : "知识库上游服务异常" },
      });
    }
  },
  {
    sessionAuth: true,
    body: "create-knowledge-base-request",
    detail: {
      tags: ["Knowledge"],
      summary: "创建知识库",
      description: "创建一个新的知识库记录，并初始化远端知识库信息。可指定嵌入模型、解析方法与内置分块方法。",
    },
  },
);

app.get(
  "/knowledgeBases/form-options",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + query
  async ({ store, query }: any) => {
    const authCtx = store.authContext!;
    let apiKey: string | undefined;
    try {
      apiKey = await resolveRagflowApiKey("global", authCtx.userId, authCtx.organizationId);
    } catch {
      // key 未配置时用 undefined，让 RagFlow provider 走默认 key 作为兜底
    }
    const data = await listKnowledgeFormOptions(apiKey);
    return { success: true as const, data };
  },
  {
    sessionAuth: true,
    response: "knowledge-form-options-response",
    detail: {
      tags: ["Knowledge"],
      summary: "获取知识库创建表单可选项",
      description:
        "返回创建知识库表单所需的嵌入模型、内置分块方法与可选 pipeline 列表。嵌入模型与 pipeline 动态拉取自 RagFlow，上游不可用时对应字段返回空数组。",
    },
  },
);

app.get(
  "/knowledgeBases/rerank-models",
  async () => {
    // rerank 模型是 RagFlow 租户级配置，与组织无关；仅需登录态访问
    const data = await listRerankModelsForOrg();
    return { success: true as const, data };
  },
  {
    sessionAuth: true,
    response: "rerank-models-response",
    detail: {
      tags: ["Knowledge"],
      summary: "获取检索测试可用的 rerank 模型列表",
      description:
        "返回当前 RagFlow 租户下已配置的 rerank 重排序模型，供知识库检索测试选择重排序模型。上游不可用时返回空数组。",
    },
  },
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
      const result = await deleteKnowledgeBase(authCtx.organizationId, id, authCtx.userId);
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
  async ({ store, params, request, query, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const overwrite = query.overwrite === "true" || query.overwrite === "1";
    try {
      const form = await request.formData();
      const files = Array.from(form.getAll("files")).filter(
        (entry: unknown): entry is globalThis.File => entry instanceof globalThis.File,
      );
      const items = await Promise.all(
        files.map((file) =>
          uploadKnowledgeResource(authCtx.organizationId, id, file as unknown as File, overwrite, authCtx.userId),
        ),
      );

      for (let index = 0; index < items.length; index += 1) {
        if (items[index]?.status !== "error") {
          continue;
        }
        await deleteKnowledgeResource(authCtx.organizationId, id, items[index]!.id, authCtx.userId);
        items[index] = await uploadKnowledgeResource(
          authCtx.organizationId,
          id,
          files[index]! as unknown as File,
          false,
          authCtx.userId,
        );
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
      const item = await importKnowledgeResourceFromUrl(
        authCtx.organizationId,
        id,
        {
          url: payload.url,
          sourceName: payload.sourceName,
        },
        authCtx.userId,
      );
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
    const items = await refreshKnowledgeResourceStatus(authCtx.organizationId, id, authCtx.userId);
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

app.get(
  "/knowledgeBases/:id/resources/:resourceId/file",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ params, error }: any) => {
    const resourceId = params.resourceId;
    const kbId = params.id;

    // 查找资源记录
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
      return new Response(null, {
        status: 302,
        headers: { Location: resource.sourcePath },
      });
    }

    // 其他非 upload/url 资源（RAGFlow 直接导入等）：通过 RAGFlow API 下载原始文件
    if (resource.remoteId) {
      const kb = await knowledgeBaseRepo.getById(kbId);
      if (kb?.remoteId) {
        try {
          const apiKey = await resolveRagflowApiKey("global", kb.userId, kb.organizationId ?? "");
          const provider = getKnowledgeProvider();
          if (provider.downloadResource) {
            const result = await provider.downloadResource({
              resourceRemoteId: resource.remoteId,
              knowledgeBaseRemoteId: kb.remoteId,
              apiKey,
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
  {
    sessionAuth: true,
    detail: {
      tags: ["Knowledge"],
      summary: "获取知识资源文件",
      description: "返回知识资源的源文件内容，用于前端预览（PDF、图片、Markdown 等）。仅 upload 类型资源支持。",
    },
  },
);

app.get(
  "/knowledgeBases/:id/resources/:resourceId/pdf",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ params, error }: any) => {
    const resourceId = params.resourceId;
    const kbId = params.id;

    // 查找资源记录
    const resource = await knowledgeResourceRepo.getById(resourceId);
    if (!resource || resource.knowledgeBaseId !== kbId) {
      return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
    }

    // 仅 upload 类型的资源有本地文件
    if (resource.sourceType !== "upload" || !resource.sourcePath) {
      return error(400, { success: false, error: { code: "NO_LOCAL_FILE", message: "该资源没有本地文件" } });
    }

    // 检查是否为 Office 文件
    const ext = extname(resource.sourceName).toLowerCase();
    if (!OFFICE_EXTENSIONS.has(ext)) {
      return error(400, {
        success: false,
        error: { code: "NOT_OFFICE_FILE", message: "该资源不是 Office 文档，无需转换" },
      });
    }

    try {
      // 验证源文件存在
      const srcStat = await stat(resource.sourcePath);
      if (!srcStat.isFile()) {
        return error(404, { success: false, error: { code: "FILE_NOT_FOUND", message: "源文件不存在" } });
      }

      // 转换为 PDF
      const pdfPath = await convertToPdf(resource.sourcePath, resource.sourceName, resourceId);
      if (!pdfPath) {
        return error(501, {
          success: false,
          error: {
            code: "CONVERSION_UNAVAILABLE",
            message: "PDF 转换服务不可用（需要 LibreOffice），请下载后本地查看",
          },
        });
      }

      const pdfStat = await stat(pdfPath);
      const file = Bun.file(pdfPath);
      return new Response(file.stream(), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(pdfStat.size),
          "Content-Disposition": `inline; filename="${encodeURIComponent(resource.sourceName.replace(ext, ".pdf"))}"`,
        },
      });
    } catch (err) {
      console.error("Failed to convert Office file to PDF", err);
      return error(500, { success: false, error: { code: "CONVERSION_ERROR", message: "PDF 转换失败" } });
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Knowledge"],
      summary: "将 Office 资源转换为 PDF",
      description: "将 Word/Excel/PPT 等 Office 文档转换为 PDF 并返回，用于前端预览。需要服务端安装 LibreOffice。",
    },
  },
);

app.patch(
  "/knowledgeBases/:id/resources/:resourceId/enabled",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const resourceId = params.resourceId;
    const enabled = body?.enabled === true || body?.enabled === "true" || body?.enabled === 1;
    try {
      const resource = await knowledgeResourceRepo.getById(resourceId);
      if (!resource || resource.knowledgeBaseId !== id) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
      }
      const resolved = await resolveKbWithApiKey(id, authCtx.organizationId, authCtx.userId);
      if (!resolved) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      }
      const { kb, apiKey } = resolved;
      const provider = getKnowledgeProvider();
      // 调用 RAGFlow 切换远程文档启用/禁用状态
      await provider.setResourceEnabled({
        resourceRemoteId: resource.remoteId!,
        knowledgeBaseRemoteId: kb.remoteId!,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
        enabled,
        apiKey,
      });
      return { success: true as const, data: { enabled } };
    } catch (err) {
      console.error(err);
      return error(400, {
        success: false,
        error: { code: "TOGGLE_FAILED", message: err instanceof Error ? err.message : "更新资源状态失败" },
      });
    }
  },
  {
    sessionAuth: true,
    response: { 200: WebOkSchema(z.object({ enabled: z.boolean() })), 400: WebErrSchema, 404: WebErrSchema },
    detail: {
      tags: ["Knowledge"],
      summary: "启用/禁用知识资源",
      description: "切换单个文档的启用状态。",
    },
  },
);

app.post(
  "/knowledgeBases/:id/resources/:resourceId/reparse",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const resourceId = params.resourceId;
    const deleteOld = body?.delete === true;
    try {
      const resource = await knowledgeResourceRepo.getById(resourceId);
      if (!resource || resource.knowledgeBaseId !== id) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
      }
      const resolved = await resolveKbWithApiKey(id, authCtx.organizationId, authCtx.userId);
      if (!resolved) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      }
      const { kb, apiKey } = resolved;
      if (!resource.remoteId || !kb.remoteId) {
        return error(400, { success: false, error: { code: "NOT_SYNCED", message: "资源尚未同步到远端" } });
      }
      const provider = getKnowledgeProvider();
      // 触发 RAGFlow 重新解析，非阻塞：成功返回后由前端轮询进度
      await provider.reparseResource({
        resourceRemoteId: resource.remoteId,
        knowledgeBaseRemoteId: kb.remoteId,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
        deleteOld,
        apiKey,
      });
      // 更新本地状态为 processing
      await knowledgeResourceRepo.update(resourceId, { status: "processing", updatedAt: new Date() });
      return { success: true as const, data: null };
    } catch (err) {
      console.error(err);
      return error(400, {
        success: false,
        error: { code: "REPARSE_FAILED", message: err instanceof Error ? err.message : "重新解析失败" },
      });
    }
  },
  {
    sessionAuth: true,
    response: { 200: WebOkSchema(z.null()), 400: WebErrSchema, 404: WebErrSchema },
    detail: {
      tags: ["Knowledge"],
      summary: "触发文档重新解析",
      description: "触发 RagFlow 对指定文档执行重新解析（异步），成功返回后由前端轮询进度。",
    },
  },
);

// ── 分页查询资源切片列表 ──
app.get(
  "/knowledgeBases/:id/resources/:resourceId/chunks",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, query, error }: any) => {
    const authCtx = store.authContext!;
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
      const resolved = await resolveKbWithApiKey(kbId, authCtx.organizationId, authCtx.userId);
      if (!resolved) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      }
      const { kb, apiKey } = resolved;
      if (!resource.remoteId || !kb.remoteId) {
        return { success: true as const, data: { items: [], total: 0, page, pageSize } };
      }
      const provider = getKnowledgeProvider();
      const result = await provider.listChunks({
        knowledgeBaseRemoteId: kb.remoteId,
        resourceRemoteId: resource.remoteId,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
        page,
        pageSize,
        keyword,
        apiKey,
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
  {
    sessionAuth: true,
    detail: {
      tags: ["Knowledge"],
      summary: "分页获取资源切片列表",
      description: "根据知识库 ID 和资源 ID 分页拉取切片列表，支持按关键词搜索。",
    },
  },
);

// ── 切换单个切片的启用/禁用状态 ──
app.patch(
  "/knowledgeBases/:id/resources/:resourceId/chunks/:chunkId/enabled",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const kbId = params.id;
    const resourceId = params.resourceId;
    const chunkId = params.chunkId;
    const enabled = Boolean(body?.enabled);

    try {
      const resource = await knowledgeResourceRepo.getById(resourceId);
      if (!resource || resource.knowledgeBaseId !== kbId) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "资源不存在" } });
      }
      const resolved = await resolveKbWithApiKey(kbId, authCtx.organizationId, authCtx.userId);
      if (!resolved) {
        return error(404, { success: false, error: { code: "NOT_FOUND", message: "知识库不存在" } });
      }
      const { kb, apiKey } = resolved;
      if (!resource.remoteId || !kb.remoteId) {
        return error(400, { success: false, error: { code: "NO_REMOTE", message: "资源未关联远端文档" } });
      }
      const provider = getKnowledgeProvider();
      await provider.switchChunk({
        knowledgeBaseRemoteId: kb.remoteId,
        resourceRemoteId: resource.remoteId,
        chunkId,
        available: enabled,
        remoteAccountId: kb.remoteAccountId ?? authCtx.userId,
        remoteUserId: kb.remoteUserId ?? authCtx.userId,
        apiKey,
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
  {
    sessionAuth: true,
    detail: {
      tags: ["Knowledge"],
      summary: "切换单个切片的启用/禁用状态",
      description: "调用 RAGFlow PATCH 接口，切换指定切片的 available 状态。",
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
      const result = await deleteKnowledgeResource(authCtx.organizationId, id, resourceId, authCtx.userId);
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

app.post(
  "/knowledgeBases/:id/search",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const payload = body as {
      query: string;
      similarityThreshold?: number;
      vectorSimilarityWeight?: number;
      rerankId?: string | null;
      keyword?: boolean;
      highlight?: boolean;
      pageSize?: number;
      page?: number;
      topK?: number;
      useKg?: boolean;
      crossLanguages?: string[];
      metaDataFilter?: import("../../services/knowledge-provider/types").MetaDataFilter;
    };

    try {
      // topK 取一个合理上限（与 RAGFlow 默认 1024 一致），检索测试不暴露此参数
      const result = await searchKnowledgeForTest({
        organizationId: authCtx.organizationId,
        knowledgeBaseId: id,
        userId: authCtx.userId,
        query: payload.query,
        topK: payload.topK ?? 1024,
        similarityThreshold: payload.similarityThreshold,
        vectorSimilarityWeight: payload.vectorSimilarityWeight,
        rerankId: payload.rerankId,
        keyword: payload.keyword,
        highlight: payload.highlight,
        pageSize: payload.pageSize,
        page: payload.page,
        useKg: payload.useKg,
        crossLanguages: payload.crossLanguages,
        metaDataFilter: payload.metaDataFilter,
      });
      return { success: true as const, data: result };
    } catch (err) {
      console.error("[knowledge-bases] search failed", { knowledgeBaseId: id, err });
      const message = err instanceof Error ? err.message : "知识库检索测试失败";
      // 知识库不存在或归属校验失败返回 404，其余上游异常返回 502
      const isNotFound = message.includes("not found");
      const code = isNotFound ? 404 : 502;
      const errCode = isNotFound ? "NOT_FOUND" : "KNOWLEDGE_PROVIDER_ERROR";
      return error(code, { success: false, error: { code: errCode, message } });
    }
  },
  {
    sessionAuth: true,
    body: "knowledge-search-body",
    response: {
      200: "knowledge-search-response",
      404: WebErrSchema,
      502: WebErrSchema,
    },
    detail: {
      tags: ["Knowledge"],
      summary: "知识库检索测试",
      description:
        "对指定知识库执行检索测试，返回命中的 chunk 列表（含三种相似度分、高亮）、总命中数与文档维度聚合。支持相似度阈值、向量/全文权重、rerank 模型、关键词匹配等核心参数。",
    },
  },
);

// ============================================================
// 知识图谱
// ============================================================

app.post(
  "/knowledgeBases/:id/graph/generate",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      await generateKnowledgeGraphForKb({
        organizationId: authCtx.organizationId,
        knowledgeBaseId: params.id,
        userId: authCtx.userId,
      });
      return { success: true as const, data: null };
    } catch (err) {
      console.error("[knowledge-bases] graph generate failed", { knowledgeBaseId: params.id, err });
      const message = err instanceof Error ? err.message : "知识图谱生成失败";
      return error(502, { success: false, error: { code: "KNOWLEDGE_PROVIDER_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["Knowledge"], summary: "生成知识图谱", description: "触发知识库的 GraphRAG 知识图谱生成流水线。" },
  },
);

app.get(
  "/knowledgeBases/:id/graph",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const result = await getKnowledgeGraphForKb({
        organizationId: authCtx.organizationId,
        knowledgeBaseId: params.id,
        userId: authCtx.userId,
      });
      return { success: true as const, data: result };
    } catch (err) {
      console.error("[knowledge-bases] graph get failed", { knowledgeBaseId: params.id, err });
      const message = err instanceof Error ? err.message : "获取知识图谱失败";
      return error(502, { success: false, error: { code: "KNOWLEDGE_PROVIDER_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["Knowledge"], summary: "获取知识图谱", description: "获取知识库的知识图谱数据（节点 + 边）。" },
  },
);

app.delete(
  "/knowledgeBases/:id/graph",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      await deleteKnowledgeGraphForKb({
        organizationId: authCtx.organizationId,
        knowledgeBaseId: params.id,
        userId: authCtx.userId,
      });
      return { success: true as const, data: null };
    } catch (err) {
      console.error("[knowledge-bases] graph delete failed", { knowledgeBaseId: params.id, err });
      const message = err instanceof Error ? err.message : "删除知识图谱失败";
      return error(502, { success: false, error: { code: "KNOWLEDGE_PROVIDER_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["Knowledge"], summary: "删除知识图谱", description: "删除知识库的知识图谱数据。" },
  },
);

app.get(
  "/knowledgeBases/:id/graph/progress",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    try {
      const result = await pollKnowledgeGraphProgressForKb({
        organizationId: authCtx.organizationId,
        knowledgeBaseId: params.id,
        userId: authCtx.userId,
      });
      return { success: true as const, data: result };
    } catch (err) {
      console.error("[knowledge-bases] graph progress failed", { knowledgeBaseId: params.id, err });
      const message = err instanceof Error ? err.message : "查询图谱进度失败";
      return error(502, { success: false, error: { code: "KNOWLEDGE_PROVIDER_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    detail: { tags: ["Knowledge"], summary: "查询图谱生成进度", description: "轮询知识图谱生成任务进度。" },
  },
);

// ===== Embedding 模型管理路由 =====
// 统一入口 POST /knowledgeBases/models，body 含 action 字段分发。
app.post(
  "/knowledgeBases/models",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as {
      action:
        | "list"
        | "list-factories"
        | "verify"
        | "list-provider-models"
        | "list-instance-models"
        | "add"
        | "delete"
        | "set-model-status";
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
          const data = await listConfiguredProviderTree("global", authCtx.userId, authCtx.organizationId);
          return { success: true as const, data };
        }
        case "list-factories": {
          const data = await listEmbeddingFactories("global", authCtx.userId, authCtx.organizationId);
          return { success: true as const, data };
        }
        case "verify": {
          if (!payload.provider || !payload.providerApiKey) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 providerApiKey 必填" },
            });
          }
          const data = await verifyEmbeddingProvider("global", authCtx.userId, authCtx.organizationId, {
            provider: payload.provider,
            providerApiKey: payload.providerApiKey,
            baseUrl: payload.baseUrl,
          });
          return { success: true as const, data };
        }
        case "list-provider-models": {
          if (!payload.provider || !payload.providerApiKey) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 providerApiKey 必填" },
            });
          }
          const data = await listProviderEmbeddingModels("global", authCtx.userId, authCtx.organizationId, {
            provider: payload.provider,
            providerApiKey: payload.providerApiKey,
            baseUrl: payload.baseUrl,
          });
          return { success: true as const, data };
        }
        case "list-instance-models": {
          if (!payload.provider || !payload.instanceName) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 instanceName 必填" },
            });
          }
          const data = await listInstanceEmbeddingModels("global", authCtx.userId, authCtx.organizationId, {
            provider: payload.provider,
            instanceName: payload.instanceName,
          });
          return { success: true as const, data };
        }
        case "set-model-status": {
          if (!payload.provider || !payload.instanceName || !payload.modelName || !payload.status) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider/instanceName/modelName/status 必填" },
            });
          }
          await setEmbeddingModelStatus("global", authCtx.userId, authCtx.organizationId, {
            provider: payload.provider,
            instanceName: payload.instanceName,
            modelName: payload.modelName,
            status: payload.status,
          });
          return { success: true as const, data: { ok: true } };
        }
        case "add": {
          if (!payload.provider || !payload.instanceName || !payload.providerApiKey) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider/instanceName/providerApiKey 必填" },
            });
          }
          const data = await addEmbeddingProvider("global", authCtx.userId, authCtx.organizationId, {
            provider: payload.provider,
            instanceName: payload.instanceName,
            providerApiKey: payload.providerApiKey,
            baseUrl: payload.baseUrl,
          });
          return { success: true as const, data };
        }
        case "delete": {
          if (!payload.provider || !payload.instanceName) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "provider 和 instanceName 必填" },
            });
          }
          await deleteEmbeddingInstance("global", authCtx.userId, authCtx.organizationId, {
            provider: payload.provider,
            instanceName: payload.instanceName,
          });
          return { success: true as const, data: { ok: true } };
        }
        default:
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: `unknown action: ${payload.action}` },
          });
      }
    } catch (err) {
      console.error("[embedding-models] action failed:", err);
      return error(502, {
        success: false,
        error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: err instanceof Error ? err.message : "操作失败" },
      });
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Knowledge"],
      summary: "Embedding 模型管理（action 分发）",
      description:
        "统一管理 embedding 模型。action 取值：list / list-factories / verify / list-provider-models / list-instance-models / add / delete / set-model-status。",
    },
  },
);

export default app;
