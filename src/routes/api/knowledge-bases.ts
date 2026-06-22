import Elysia from "elysia";
import * as z from "zod/v4";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  type ApiKnowledgeBaseListQuery,
  ApiKnowledgeBaseListQuerySchema,
  ApiKnowledgeBaseListResponseSchema,
} from "../../schemas/api-knowledge.schema";
import { listKnowledgeBasesByTeamId } from "../../services/knowledge-base";

const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("错误码。"),
    message: z.string().describe("错误描述。"),
  }),
});

const app = new Elysia({ name: "api-knowledge-bases", prefix: "/api/knowledge-bases" }).use(authGuardPlugin).model({
  "api-knowledge-base-list-query": ApiKnowledgeBaseListQuerySchema,
  "api-knowledge-base-list-response": ApiKnowledgeBaseListResponseSchema,
});

app.get(
  "",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { page, pageSize } = query as ApiKnowledgeBaseListQuery;

    try {
      const rows = await listKnowledgeBasesByTeamId(authCtx.organizationId);
      const total = rows.length;
      const start = (page - 1) * pageSize;
      return {
        items: rows.slice(start, start + pageSize),
        total,
        page,
        pageSize,
      };
    } catch (err) {
      console.error(err);
      return error(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
        },
      });
    }
  },
  {
    sessionAuth: true,
    query: "api-knowledge-base-list-query",
    response: {
      200: "api-knowledge-base-list-response",
      401: ApiErrorResponseSchema,
      403: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Knowledge"],
      summary: "获取知识库列表",
      description: "返回当前调用方所属组织下可访问的知识库分页列表。",
    },
  },
);

export default app;
