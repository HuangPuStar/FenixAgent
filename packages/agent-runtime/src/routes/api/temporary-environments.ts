import { createLogger } from "@fenix/logger";
import { OrchestrationError } from "@fenix/orchestration";
import { ApiV1ErrSchema, ApiV1OkSchema, AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { mapOrchestrationErrorToHttp } from "../../errors/orchestration-http";
import { TemporaryEnvironmentFacade } from "../../facades/temporary-environment-facade";
import type { InstanceOwner } from "../../server/services/api-instance-resolution";
import type { AgentRuntimeAuthDependencies } from "../dependencies";

const detail = z.object({ environmentId: z.string(), instanceId: z.string(), expiresAt: z.iso.datetime() });
function owner(store: { authContext?: InstanceOwner | null }): InstanceOwner {
  if (!store.authContext?.organizationId || !store.authContext.userId)
    throw new AppError("Authentication required", "UNAUTHORIZED", 401);
  return store.authContext;
}
/** 临时环境创建/续期协议适配，归属与资源 use 权限由 Facade 判定。 */
export function createTemporaryEnvironmentRoutes(
  deps: AgentRuntimeAuthDependencies,
  facade: Pick<TemporaryEnvironmentFacade, "create" | "renew"> = new TemporaryEnvironmentFacade(),
) {
  const common = {
    sessionAuth: true as const,
    query: z.object({}),
    headers: z.object({}).passthrough(),
    response: {
      400: ApiV1ErrSchema,
      401: ApiV1ErrSchema,
      404: ApiV1ErrSchema,
      409: ApiV1ErrSchema,
      410: ApiV1ErrSchema,
      429: ApiV1ErrSchema,
      422: ApiV1ErrSchema,
      500: ApiV1ErrSchema,
      503: ApiV1ErrSchema,
    },
  };
  return new Elysia({ name: "temporary-environments", prefix: "/api/v1" })
    .use(deps.authGuardPlugin)
    .onError(({ error, set, code }) => {
      createLogger("temporary-environment-api").error("Environment operation failed", error);
      if (error instanceof OrchestrationError) {
        const mapped = mapOrchestrationErrorToHttp(error);
        set.status = mapped.status;
        return { success: false as const, error: { code: error.code, message: mapped.message } };
      }
      if (error instanceof AppError) {
        set.status = error.statusCode;
        return {
          success: false as const,
          error: {
            code: error.code,
            message: error.statusCode >= 500 ? "Environment service unavailable" : error.message,
          },
        };
      }
      set.status = code === "VALIDATION" ? 400 : 500;
      return {
        success: false as const,
        error: {
          code: code === "VALIDATION" ? "VALIDATION_ERROR" : "INTERNAL_ERROR",
          message: code === "VALIDATION" ? "Invalid request" : "Environment service unavailable",
        },
      };
    })
    .post(
      "/agents/:id/environments",
      async ({ store, params, set }) => {
        const data = await facade.create(owner(store), params.id);
        set.status = 201;
        return { success: true as const, data };
      },
      {
        ...common,
        params: z.object({ id: z.uuid() }),
        body: z.strictObject({ temporary: z.literal(true) }),
        response: { ...common.response, 201: ApiV1OkSchema(detail) },
        detail: { tags: ["External Environment"], summary: "创建独立临时环境，不启动 Runtime" },
      },
    )
    .post(
      "/environments/:environmentId/renew",
      async ({ store, params, request }) => ({
        success: true as const,
        data: await facade.renew(owner(store), params.environmentId, request.signal),
      }),
      {
        ...common,
        params: z.object({ environmentId: z.string().min(1) }),
        body: z.strictObject({}),
        response: { ...common.response, 200: ApiV1OkSchema(detail.extend({ status: z.literal("running") })) },
        detail: { tags: ["External Environment"], summary: "续期临时环境并显式恢复原实例" },
      },
    );
}
