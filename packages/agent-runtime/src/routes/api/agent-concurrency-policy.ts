import { ApiSystemErrorResponseSchema, AppError } from "@fenix/platform-sdk";
import Elysia, { type AnyElysia } from "elysia";
import * as z from "zod/v4";
import {
  type AgentConcurrencyPolicyFacade,
  agentConcurrencyPolicyFacade,
} from "../../facades/agent-concurrency-policy-facade";
import {
  ConcurrencyPatchSchema,
  ConcurrencyPolicyViewSchema,
  UserConcurrencyPolicySchema,
  UserConcurrencyPutSchema,
} from "../../schemas/agent-concurrency-policy.schema";

/** 复用宿主系统密钥守卫，所有入口只经系统管理门面执行。 */
export function createAgentConcurrencyPolicyRoutes(
  deps: { systemApiGuardPlugin: AnyElysia },
  facade: AgentConcurrencyPolicyFacade = agentConcurrencyPolicyFacade,
) {
  const app = new Elysia({ name: "api-system-agent-concurrency", prefix: "/api/system/agent-concurrency" }).use(
    deps.systemApiGuardPlugin,
  );
  const headers = z.object({ authorization: z.string().optional() });
  const empty = z.object({});
  const params = z.object({ userId: z.string().min(1) });
  const globalResponse = z.object({ success: z.literal(true), data: ConcurrencyPolicyViewSchema });
  const userResponse = z.object({ success: z.literal(true), data: UserConcurrencyPolicySchema });
  const errors = {
    401: ApiSystemErrorResponseSchema,
    404: ApiSystemErrorResponseSchema,
    503: ApiSystemErrorResponseSchema,
  };
  app.onError(({ error, set }) => {
    if (error instanceof AppError) {
      set.status = error.statusCode;
      return { error: { code: error.code, message: error.message } };
    }
  });
  return app
    .get("", () => ({ success: true as const, data: facade.getGlobal() }), {
      systemApiKeyAuth: true,
      headers,
      query: empty,
      params: empty.optional(),
      response: { 200: globalResponse, ...errors },
      detail: { tags: ["System"], summary: "Get effective Agent concurrency policy" },
    })
    .patch("", async ({ body }) => ({ success: true as const, data: await facade.patchGlobal(body) }), {
      systemApiKeyAuth: true,
      headers,
      query: empty,
      params: empty.optional(),
      body: ConcurrencyPatchSchema,
      response: { 200: globalResponse, ...errors },
      detail: { tags: ["System"], summary: "Update global Agent concurrency overrides" },
    })
    .get(
      "/user-candidates",
      async ({ query }) => ({ success: true as const, data: await facade.searchUsers(query.keyword ?? "") }),
      {
        systemApiKeyAuth: true,
        headers,
        params: empty.optional(),
        query: z.object({ keyword: z.string().max(200).optional() }),
        response: {
          200: z.object({
            success: z.literal(true),
            data: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
          }),
          ...errors,
        },
        detail: { tags: ["System"], summary: "Search user candidates for concurrency configuration" },
      },
    )
    .get("/users", async () => ({ success: true as const, data: await facade.listUsers() }), {
      systemApiKeyAuth: true,
      headers,
      query: empty,
      params: empty.optional(),
      response: { 200: z.object({ success: z.literal(true), data: UserConcurrencyPolicySchema.array() }), ...errors },
      detail: { tags: ["System"], summary: "List explicit user concurrency overrides" },
    })
    .get(
      "/users/:userId",
      async ({ params }) => ({ success: true as const, data: await facade.getUser(params.userId) }),
      {
        systemApiKeyAuth: true,
        headers,
        query: empty,
        params,
        response: { 200: userResponse, ...errors },
        detail: { tags: ["System"], summary: "Get effective user concurrency policy" },
      },
    )
    .put(
      "/users/:userId",
      async ({ params, body }) => ({
        success: true as const,
        data: await facade.putUser(params.userId, body.userAgentMaxConcurrency),
      }),
      {
        systemApiKeyAuth: true,
        headers,
        query: empty,
        params,
        body: UserConcurrencyPutSchema,
        response: { 200: userResponse, ...errors },
        detail: { tags: ["System"], summary: "Replace user concurrency override" },
      },
    )
    .delete(
      "/users/:userId",
      async ({ params }) => ({ success: true as const, data: await facade.deleteUser(params.userId) }),
      {
        systemApiKeyAuth: true,
        headers,
        query: empty,
        params,
        response: { 200: userResponse, ...errors },
        detail: { tags: ["System"], summary: "Restore inherited user concurrency policy" },
      },
    );
}
