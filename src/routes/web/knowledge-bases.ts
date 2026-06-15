import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  CreateKnowledgeBaseRequestSchema,
  DeleteKnowledgeBaseResponseSchema,
  DeleteKnowledgeResourceResponseSchema,
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
  "delete-knowledge-base-response": DeleteKnowledgeBaseResponseSchema,
  "delete-knowledge-resource-response": DeleteKnowledgeResourceResponseSchema,
});

app.get(
  "/knowledgeBases",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    return await listKnowledgeBasesByTeamId(authCtx.organizationId);
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
    const payload = body as { name: string; slug: string; description?: string };
    const result = await createKnowledgeBaseRecord(
      authCtx.organizationId,
      {
        name: payload.name,
        slug: payload.slug,
        description: payload.description,
      },
      authCtx.userId,
    );
    if (!result.success) {
      return error(400, { error: { type: result.error.code, message: result.error.message } });
    }
    return result.data;
  },
  {
    sessionAuth: true,
    body: "create-knowledge-base-request",
    response: "knowledge-base-info",
    detail: {
      tags: ["Knowledge"],
      summary: "创建知识库",
      description: "创建一个新的知识库记录，并初始化远端知识库信息。",
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
      return error(404, { error: { type: "NOT_FOUND", message: "知识库不存在" } });
    }
    return detail;
  },
  {
    sessionAuth: true,
    response: "knowledge-base-detail",
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
      return error(status, { error: { type: result.error.code, message: result.error.message } });
    }
    return result.data;
  },
  {
    sessionAuth: true,
    body: "update-knowledge-base-request",
    response: "knowledge-base-info",
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
        return error(404, { error: { type: "NOT_FOUND", message: result.error.message } });
      }
      return { ok: true as const };
    } catch (err) {
      return error(400, {
        error: {
          type: "DELETE_FAILED",
          message: err instanceof Error ? err.message : "删除知识库失败",
        },
      });
    }
  },
  {
    sessionAuth: true,
    response: "delete-knowledge-base-response",
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
      return { items };
    } catch (err) {
      const message = (err as Error).message;
      const status = message.includes("不存在") ? 404 : 400;
      return error(status, { error: { type: status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    response: "upload-knowledge-resources-response",
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
      return error(400, { error: { type: "VALIDATION_ERROR", message: "url 为必填字段" } });
    }
    try {
      const item = await importKnowledgeResourceFromUrl(authCtx.organizationId, id, {
        url: payload.url,
        sourceName: payload.sourceName,
      });
      const status = item.status === "error" ? 502 : 201;
      if (status >= 400) return error(status, item);
      return item;
    } catch (err) {
      const message = (err as Error).message;
      const status = message.includes("不存在") ? 404 : 400;
      return error(status, { error: { type: status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    body: "import-knowledge-url-request",
    response: "import-knowledge-url-response",
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
      return error(404, { error: { type: "NOT_FOUND", message: "知识库不存在" } });
    }
    return items;
  },
  {
    sessionAuth: true,
    response: "knowledge-resource-list",
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
        return error(404, { error: { type: result.error.code, message: result.error.message } });
      }
      return result.data;
    } catch (err) {
      return error(400, {
        error: {
          type: "DELETE_FAILED",
          message: err instanceof Error ? err.message : "删除资源失败",
        },
      });
    }
  },
  {
    sessionAuth: true,
    response: "delete-knowledge-resource-response",
    detail: {
      tags: ["Knowledge"],
      summary: "删除知识资源",
      description: "删除指定知识库下的单个资源记录及其远端资源。",
    },
  },
);

export default app;
