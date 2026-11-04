import { error as logError } from "@fenix/logger";
import { type ActorContext, ApiV1ErrSchema, ApiV1OkSchema, AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  ApiMcpCreateBodySchema,
  ApiMcpDeleteResponseSchema,
  ApiMcpDetailSchema,
  ApiMcpIdParamsSchema,
  ApiMcpListQuerySchema,
  ApiMcpListResponseSchema,
  ApiMcpUpdateBodySchema,
} from "../../schemas/api-mcp.schema";
import { ApiV1McpService } from "../../services/api-v1-mcp";
import type { McpRouteDependencies } from "../dependencies";

/** v1 transport maps HTTP DTOs; authorization remains in the resource application entry. */
export function createApiMcpRoutes(deps: McpRouteDependencies) {
  const service = new ApiV1McpService();
  const failures = {
    400: ApiV1ErrSchema,
    401: ApiV1ErrSchema,
    403: ApiV1ErrSchema,
    404: ApiV1ErrSchema,
    409: ApiV1ErrSchema,
    500: ApiV1ErrSchema,
  };
  return new Elysia({ name: "api-mcp", prefix: "/api/v1/mcp-servers" })
    .use(deps.authGuardPlugin)
    .onError(({ error, code, set }) => {
      if (code === "NOT_FOUND" && !(error instanceof AppError)) {
        set.status = 404;
        return { success: false as const, error: { code: "NOT_FOUND", message: "Route not found" } };
      }
      if (code !== "VALIDATION" && !(error instanceof AppError)) logError("[api-mcp] Request failed", error);
      set.status = code === "VALIDATION" ? 400 : error instanceof AppError ? error.statusCode : 500;
      return {
        success: false as const,
        error: {
          code: code === "VALIDATION" ? "VALIDATION_ERROR" : error instanceof AppError ? error.code : "INTERNAL_ERROR",
          message:
            code === "VALIDATION"
              ? "Invalid request"
              : error instanceof AppError && error.statusCode < 500
                ? error.message
                : "Internal server error",
        },
      };
    })
    .get(
      "",
      async ({ store, query }) => ({
        success: true as const,
        data: await service.list(requireActor(store.actor as ActorContext | null), query),
      }),
      {
        sessionAuth: true,
        query: ApiMcpListQuerySchema,
        response: { 200: ApiV1OkSchema(ApiMcpListResponseSchema), ...failures },
        detail: { tags: ["External MCP"], summary: "查询 MCP" },
      },
    )
    .get(
      "/:id",
      async ({ store, params }) => ({
        success: true as const,
        data: await service.get(requireActor(store.actor as ActorContext | null), params.id),
      }),
      {
        sessionAuth: true,
        params: ApiMcpIdParamsSchema,
        response: { 200: ApiV1OkSchema(ApiMcpDetailSchema), ...failures },
        detail: { tags: ["External MCP"], summary: "MCP 详情" },
      },
    )
    .post(
      "",
      async ({ store, body, set }) => {
        const data = await service.create(requireActor(store.actor as ActorContext | null), body);
        set.status = 201;
        return { success: true as const, data };
      },
      {
        sessionAuth: true,
        body: ApiMcpCreateBodySchema,
        response: { 201: ApiV1OkSchema(ApiMcpDetailSchema), ...failures },
        detail: { tags: ["External MCP"], summary: "创建 MCP" },
      },
    )
    .patch(
      "/:id",
      async ({ store, params, body }) => ({
        success: true as const,
        data: await service.patch(requireActor(store.actor as ActorContext | null), params.id, body),
      }),
      {
        sessionAuth: true,
        params: ApiMcpIdParamsSchema,
        body: ApiMcpUpdateBodySchema,
        response: { 200: ApiV1OkSchema(ApiMcpDetailSchema), ...failures },
        detail: { tags: ["External MCP"], summary: "更新 MCP" },
      },
    )
    .delete(
      "/:id",
      async ({ store, params }) => ({
        success: true as const,
        data: await service.remove(requireActor(store.actor as ActorContext | null), params.id),
      }),
      {
        sessionAuth: true,
        params: ApiMcpIdParamsSchema,
        response: { 200: ApiV1OkSchema(ApiMcpDeleteResponseSchema), ...failures },
        detail: { tags: ["External MCP"], summary: "删除 MCP" },
      },
    );
}

/** Reject missing authenticated organization before invoking resource actions. */
function requireActor(actor: ActorContext | null): ActorContext {
  if (!actor) throw new AppError("请求缺少组织上下文", "UNAUTHORIZED", 401);
  return actor;
}
