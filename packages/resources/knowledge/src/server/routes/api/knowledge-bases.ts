import { ApiV1ErrSchema, ApiV1OkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { knowledgeBaseFacade } from "../../facades/knowledge-base-facade";
import {
  ApiKnowledgeBaseListQuerySchema,
  ApiKnowledgeBaseListResponseSchema,
} from "../../schemas/api-knowledge.schema";
import type { KnowledgeRouteDependencies, SessionAuthContext } from "../dependencies";
/** Organization-scoped read-only v1 knowledge directory. */
export function createApiKnowledgeBaseRoutes(deps: KnowledgeRouteDependencies) {
  return new Elysia({ name: "api-knowledge-bases", prefix: "/api/v1/knowledge-bases" }).use(deps.authGuardPlugin).get(
    "",
    async ({ store, query, request }) => ({
      success: true as const,
      data: await knowledgeBaseFacade.listForExternal(
        store.authContext as SessionAuthContext,
        query.page,
        query.pageSize,
        request.signal,
      ),
    }),
    {
      sessionAuth: true,
      query: ApiKnowledgeBaseListQuerySchema,
      response: {
        200: ApiV1OkSchema(ApiKnowledgeBaseListResponseSchema),
        400: ApiV1ErrSchema,
        401: ApiV1ErrSchema,
        403: ApiV1ErrSchema,
        500: ApiV1ErrSchema,
      },
      detail: { tags: ["External Knowledge"], summary: "查询当前组织已有知识库" },
    },
  );
}
