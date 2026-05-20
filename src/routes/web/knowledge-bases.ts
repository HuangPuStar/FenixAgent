import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  CreateKnowledgeBaseRequestSchema,
  ImportKnowledgeUrlRequestSchema,
  KnowledgeBaseInfoSchema,
  KnowledgeResourceItemSchema,
  UpdateKnowledgeBaseRequestSchema,
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


const app = new Elysia({ name: "web-knowledge-bases", prefix: "/web" }).use(authGuardPlugin).model({
  "knowledge-base-info": KnowledgeBaseInfoSchema,
  "knowledge-base-list": KnowledgeBaseInfoSchema.array(),
  "knowledge-resource-item": KnowledgeResourceItemSchema,
  "knowledge-resource-list": KnowledgeResourceItemSchema.array(),
  "create-knowledge-base-request": CreateKnowledgeBaseRequestSchema,
  "update-knowledge-base-request": UpdateKnowledgeBaseRequestSchema,
  "import-knowledge-url-request": ImportKnowledgeUrlRequestSchema,
});

app.get(
  "/knowledgeBases",
  async ({ store, request }: any) => {
    const authCtx = store.authContext!;
    return await listKnowledgeBasesByTeamId(authCtx.organizationId);
  },
  { sessionAuth: true, response: "knowledge-base-list" },
);

app.post(
  "/knowledgeBases",
  async ({ store, body, error, request }: any) => {
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
  { sessionAuth: true, body: "create-knowledge-base-request" },
);

app.get(
  "/knowledgeBases/:id",
  async ({ store, params, error, request }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const detail = await getKnowledgeBaseDetail(authCtx.organizationId, id);
    if (!detail) {
      return error(404, { error: { type: "NOT_FOUND", message: "知识库不存在" } });
    }
    return detail;
  },
  { sessionAuth: true },
);

app.patch(
  "/knowledgeBases/:id",
  async ({ store, params, body, error, request }: any) => {
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
  { sessionAuth: true, body: "update-knowledge-base-request" },
);

app.delete(
  "/knowledgeBases/:id",
  async ({ store, params, error, request }: any) => {
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
  { sessionAuth: true },
);

app.post(
  "/knowledgeBases/:id/resources/upload",
  async ({ store, params, request, error }) => {
    const authCtx = store.authContext!;
    const id = params.id;
    try {
      const form = await request.formData();
      const files = Array.from(form.getAll("files")).filter(
        (entry: any): entry is globalThis.File => entry instanceof globalThis.File,
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
  { sessionAuth: true },
);

app.post(
  "/knowledgeBases/:id/resources/url",
  async ({ store, params, body, error, request }: any) => {
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
  { sessionAuth: true, body: "import-knowledge-url-request" },
);

app.get(
  "/knowledgeBases/:id/resources",
  async ({ store, params, error, request }: any) => {
    const authCtx = store.authContext!;
    const id = params.id;
    const items = await listKnowledgeResources(authCtx.organizationId, id);
    if (!items) {
      return error(404, { error: { type: "NOT_FOUND", message: "知识库不存在" } });
    }
    return items;
  },
  { sessionAuth: true },
);

app.delete(
  "/knowledgeBases/:id/resources/:resourceId",
  async ({ store, params, error, request }: any) => {
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
  { sessionAuth: true },
);

export default app;
