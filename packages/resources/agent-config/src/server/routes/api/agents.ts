import { type ActorContext, ApiV1ErrSchema, ApiV1OkSchema, AppError } from "@fenix/platform-sdk";
import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import Elysia from "elysia";
import * as z from "zod/v4";
import { ApiV1AgentFacade } from "../../facades/api-v1-agent-facade";
import {
  ApiAgentDetailSchema,
  ApiAgentIdParamsSchema,
  ApiAgentListQuerySchema,
  ApiAgentListResponseSchema,
  ApiAgentUpdateBodySchema,
  ApiAgentUpsertBodySchema,
} from "../../schemas/api-agent.schema";
import type { ApiAgentConfigRouteDependencies } from "../dependencies";

/** Require the host-authenticated actor; body and query never supply identity. */
function actorOf(store: { actor?: ActorContext | null }) {
  if (!store.actor) throw new AppError("请求缺少组织上下文", "UNAUTHORIZED", 401);
  return store.actor;
}

/** Stable Agent v1 HTTP adapter. */
export function createApiAgentsRoutes(deps: ApiAgentConfigRouteDependencies) {
  return new Elysia({ name: "api-agents", prefix: "/api/v1/agents" })
    .use(deps.authGuardPlugin)
    .onError(({ error, set }) => {
      if (error instanceof InvalidKnowledgeBindingError) {
        set.status = 400;
        return {
          success: false as const,
          error: { code: "INVALID_KNOWLEDGE_BINDINGS", message: "知识库不存在或不可访问" },
        };
      }
      if (error instanceof AppError) {
        set.status = error.statusCode;
        return {
          success: false as const,
          error: { code: error.code, message: error.statusCode >= 500 ? "Internal server error" : error.message },
        };
      }
    })
    .get(
      "",
      async ({ store, query }) => ({
        success: true as const,
        data: await new ApiV1AgentFacade().list(actorOf(store), query),
      }),
      {
        sessionAuth: true,
        query: ApiAgentListQuerySchema,
        response: { 200: ApiV1OkSchema(ApiAgentListResponseSchema), 401: ApiV1ErrSchema },
        detail: { tags: ["External Agent"], summary: "获取 Agent 列表" },
      },
    )
    .get(
      "/:id",
      async ({ store, params }) => ({
        success: true as const,
        data: await new ApiV1AgentFacade().get(actorOf(store), params.id),
      }),
      {
        sessionAuth: true,
        params: ApiAgentIdParamsSchema,
        response: { 200: ApiV1OkSchema(ApiAgentDetailSchema), 401: ApiV1ErrSchema, 404: ApiV1ErrSchema },
        detail: { tags: ["External Agent"], summary: "获取 Agent 详情" },
      },
    )
    .post(
      "",
      async ({ store, body, set }) => {
        const data = await new ApiV1AgentFacade().create(actorOf(store), body);
        set.status = 201;
        return { success: true as const, data };
      },
      {
        sessionAuth: true,
        body: ApiAgentUpsertBodySchema,
        response: {
          201: ApiV1OkSchema(ApiAgentDetailSchema),
          400: ApiV1ErrSchema,
          401: ApiV1ErrSchema,
          409: ApiV1ErrSchema,
        },
        detail: { tags: ["External Agent"], summary: "创建 Agent 与绑定" },
      },
    )
    .patch(
      "/:id",
      async ({ store, params, body }) => ({
        success: true as const,
        data: await new ApiV1AgentFacade().patch(actorOf(store), params.id, body),
      }),
      {
        sessionAuth: true,
        params: ApiAgentIdParamsSchema,
        body: ApiAgentUpdateBodySchema,
        response: {
          200: ApiV1OkSchema(ApiAgentDetailSchema),
          400: ApiV1ErrSchema,
          401: ApiV1ErrSchema,
          403: ApiV1ErrSchema,
          404: ApiV1ErrSchema,
        },
        detail: { tags: ["External Agent"], summary: "部分更新 Agent 与绑定" },
      },
    )
    .delete(
      "/:id",
      async ({ store, params }) => ({
        success: true as const,
        data: await new ApiV1AgentFacade().remove(actorOf(store), params.id),
      }),
      {
        sessionAuth: true,
        params: ApiAgentIdParamsSchema,
        response: { 200: ApiV1OkSchema(z.null()), 401: ApiV1ErrSchema, 403: ApiV1ErrSchema, 404: ApiV1ErrSchema },
        detail: { tags: ["External Agent"], summary: "删除 Agent" },
      },
    );
}
