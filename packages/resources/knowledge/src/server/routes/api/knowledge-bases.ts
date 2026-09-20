import { ApiErrorResponseSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  type ApiKnowledgeBaseListQuery,
  ApiKnowledgeBaseListQuerySchema,
  ApiKnowledgeBaseListResponseSchema,
} from "../../schemas/api-knowledge.schema";
import { listKnowledgeBasesByTeamId, listKnowledgeBasesGlobal } from "../../services/knowledge-base";
import type { KnowledgeRouteDependencies, SessionAuthContext } from "../dependencies";

/**
 * `/api/knowledge-bases` 对外稳定接口工厂（1 条端点）。
 *
 * 守卫由宿主注入（`deps.authGuardPlugin`）：Elysia 的 macro / state 是实例作用域的，父实例无法向已
 * 构造的子实例回填，本包不得 import `@server/plugins/auth`（否则离开宿主即无法构造与测试）。
 *
 * 列表合并「本组织可见」与「全局」两部分：全局知识库跨组织可见是本接口的既有语义，因此这里不做
 * 组织过滤，靠 `listKnowledgeBasesByTeamId` 返回本组织行、`listKnowledgeBasesGlobal` 返回全局行。
 * 分页在合并后的数组上做（两家数据源的条数上限远小于分页成本）。
 */
export function createApiKnowledgeBaseRoutes(deps: KnowledgeRouteDependencies) {
  const app = new Elysia({ name: "api-knowledge-bases", prefix: "/api/knowledge-bases" })
    .use(deps.authGuardPlugin)
    .model({
      "api-knowledge-base-list-query": ApiKnowledgeBaseListQuerySchema,
      "api-knowledge-base-list-response": ApiKnowledgeBaseListResponseSchema,
    });

  app.get(
    "",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
    async ({ store, query, error }: any) => {
      const authCtx = store.authContext as SessionAuthContext;
      const { page, pageSize } = query as ApiKnowledgeBaseListQuery;

      try {
        const [orgRows, globalRows] = await Promise.all([
          listKnowledgeBasesByTeamId(authCtx.organizationId),
          listKnowledgeBasesGlobal(),
        ]);
        const rows = [...orgRows, ...globalRows];
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
        description: "返回当前调用方可访问的知识库分页列表。",
      },
    },
  );

  return app;
}
