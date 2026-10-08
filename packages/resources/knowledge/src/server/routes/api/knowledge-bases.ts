import { ApiErrorResponseSchema, AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { knowledgeBaseFacade } from "../../facades/knowledge-base-facade";
import {
  type ApiKnowledgeBaseListQuery,
  ApiKnowledgeBaseListQuerySchema,
  ApiKnowledgeBaseListResponseSchema,
} from "../../schemas/api-knowledge.schema";
import type { KnowledgeRouteDependencies, SessionAuthContext } from "../dependencies";

/**
 * `/api/knowledge-bases` 对外稳定接口工厂（1 条端点）。
 *
 * 守卫由宿主注入（`deps.authGuardPlugin`）：Elysia 的 macro / state 是实例作用域的，父实例无法向已
 * 构造的子实例回填，本包不得 import `@server/plugins/auth`（否则离开宿主即无法构造与测试）。
 *
 * 本层只是薄协议 adapter：把查询参数翻译成页码与页大小，交给 Facade（`listForExternal`）后拼成已发布的
 * 分页信封。**可见范围不在本层**——「本组织 ∪ 跨组织共享的全局知识库」是门面上的命名语义，控制台列表
 * （`/web/knowledgeBases`）走同一个门面的另一条命名方法；两条协议面因此不可能各自定义一份可见集合。
 */

/** 把应用错误映射为对外 API 的稳定错误结构；非 `AppError` 一律 500 INTERNAL_ERROR（与改动前一致）。 */
function mapApiError(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof AppError) {
    return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" } },
  };
}

/**
 * 构造 `/api/knowledge-bases` 路由实例。
 *
 * 授权来源：宿主注入的会话守卫写入 `store.authContext`（session / Environment Secret / API Key），
 * 组织隔离由 `authCtx.organizationId` 决定，路由不自行解释角色或 `visibility`。
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
        return await knowledgeBaseFacade.listForExternal(authCtx, page, pageSize);
      } catch (err) {
        console.error(err);
        const mapped = mapApiError(err);
        return error(mapped.status, mapped.body);
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
