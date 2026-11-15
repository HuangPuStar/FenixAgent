import { type ActorContext, ApiV1ErrSchema, ApiV1OkSchema, AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { EnvironmentPolicyFacade } from "../../facades/environment-policy-facade";
import type { ApiAgentConfigRouteDependencies } from "../dependencies";

const params = z.object({ id: z.uuid() });
const response = z.object({
  source: z.enum(["default", "agent"]),
  ttlSeconds: z.number().int().positive().nullable(),
  effectiveTtlSeconds: z.number().int().positive(),
  maxTtlSeconds: z.number().int().positive(),
});
function actor(store: { actor?: ActorContext | null }): ActorContext {
  if (!store.actor) throw new AppError("Authentication required", "UNAUTHORIZED", 401);
  return store.actor;
}
/** AgentConfig 策略协议适配；授权及持久化均经 Facade。 */
export function createEnvironmentPolicyRoutes(deps: ApiAgentConfigRouteDependencies) {
  const facade = new EnvironmentPolicyFacade();
  const options = {
    sessionAuth: true as const,
    params,
    query: z.object({}),
    headers: z.object({}).passthrough(),
    response: {
      200: ApiV1OkSchema(response),
      400: ApiV1ErrSchema,
      401: ApiV1ErrSchema,
      403: ApiV1ErrSchema,
      404: ApiV1ErrSchema,
    },
  };
  return new Elysia({ name: "agent-environment-policy", prefix: "/api/v1/agents" })
    .use(deps.authGuardPlugin)
    .onError(({ error, set }) => {
      if (error instanceof AppError) {
        set.status = error.statusCode;
        return {
          success: false as const,
          error: { code: error.code, message: error.statusCode >= 500 ? "Internal server error" : error.message },
        };
      }
    })
    .get(
      "/:id/environment-policy",
      async ({ store, params }) => ({ success: true as const, data: await facade.get(actor(store), params.id) }),
      { ...options, detail: { tags: ["External Agent"], summary: "读取临时环境 TTL 策略" } },
    )
    .put(
      "/:id/environment-policy",
      async ({ store, params, body }) => ({
        success: true as const,
        data: await facade.put(actor(store), params.id, body.ttlSeconds),
      }),
      {
        ...options,
        body: z.strictObject({ ttlSeconds: z.number().int().positive() }),
        detail: { tags: ["External Agent"], summary: "替换临时环境 TTL 策略" },
      },
    )
    .delete(
      "/:id/environment-policy",
      async ({ store, params }) => ({ success: true as const, data: await facade.remove(actor(store), params.id) }),
      {
        ...options,
        response: { ...options.response, 200: ApiV1OkSchema(z.null()) },
        detail: { tags: ["External Agent"], summary: "删除临时环境 TTL 覆盖" },
      },
    );
}
