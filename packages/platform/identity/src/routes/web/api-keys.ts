import { WebErrSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import {
  ApiKeyCreateResponseSchema,
  ApiKeyDeleteResponseSchema,
  ApiKeyListResponseSchema,
  ApiKeyVoidResponseSchema,
  CreateApiKeyBodySchema,
  UpdateApiKeyBodySchema,
} from "../../schemas/organization.schema";
import {
  buildApiKeyMetadata,
  createCallerApiKey,
  deleteCallerApiKey,
  listCallerApiKeys,
  normalizeApiKeyDateValues,
  normalizeApiKeyName,
  updateCallerApiKey,
} from "../../services/caller-api-keys";
import type { WebIdentityRouteDependencies } from "../dependencies";

/**
 * `/web/api-keys` 路由（CE 阶段 2 任务 1.2）。
 *
 * 从 `packages/resources/identity-admin` 迁入并改为工厂：守卫必须与宿主的认证解析是同一份实例
 * （Elysia 的 macro / state 是实例作用域的，父实例无法向已构造的子实例回填），因此由宿主注入
 * `authGuardPlugin`，本模块不再持有自己的守卫。
 *
 * 所有 better-auth 交互收敛到 `services/caller-api-keys`，本文件只做协议接入与响应映射。
 */
export function createWebApiKeysRoutes(deps: WebIdentityRouteDependencies) {
  const app = new Elysia({ name: "web-api-keys" }).use(deps.authGuardPlugin).model({
    "apikey-list-response": ApiKeyListResponseSchema,
    "apikey-create-response": ApiKeyCreateResponseSchema,
    "apikey-delete-response": ApiKeyDeleteResponseSchema,
    "apikey-void-response": ApiKeyVoidResponseSchema,
  });

  // GET /web/api-keys → 获取 API Key 列表
  app.get(
    "/api-keys",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ request }: any) => {
      const keys = await listCallerApiKeys(request.headers);
      // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
      return { success: true as const, data: normalizeApiKeyDateValues(keys) } as any;
    },
    {
      sessionAuth: true,
      response: {
        200: ApiKeyListResponseSchema,
        403: WebErrSchema,
      },
      detail: {
        tags: ["Organizations"],
        summary: "获取 API Key 列表",
        description: "返回当前用户在当前组织下创建的 API Key 列表。",
      },
    },
  );

  // POST /web/api-keys → 创建 API Key
  app.post(
    "/api-keys",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store, body, error, request }: any) => {
      const b = body ?? {};
      const normalizedName = normalizeApiKeyName(b.name);
      if (!normalizedName) {
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name required" } });
      }
      const authContext = store.authContext;
      if (!authContext) {
        return error(403, {
          success: false,
          error: { code: "FORBIDDEN", message: "No organization context" },
        });
      }
      const existingApiKeys = await listCallerApiKeys(request.headers);
      const duplicatedName = existingApiKeys.some((apiKey) => apiKey.name === normalizedName);
      if (duplicatedName) {
        return error(400, {
          success: false,
          error: { code: "DUPLICATE_API_KEY_NAME", message: "API key name already exists" },
        });
      }
      const result = await createCallerApiKey({
        headers: request.headers,
        name: normalizedName,
        prefix: "rcs_",
        expiresIn: b.expiresAt ? Math.ceil((new Date(b.expiresAt).getTime() - Date.now()) / 1000) : null,
        metadata: buildApiKeyMetadata(b.metadata, authContext),
      });
      // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
      return { success: true as const, data: normalizeApiKeyDateValues(result) } as any;
    },
    {
      sessionAuth: true,
      body: CreateApiKeyBodySchema,
      response: {
        200: ApiKeyCreateResponseSchema,
        400: WebErrSchema,
        403: WebErrSchema,
      },
      detail: {
        tags: ["Organizations"],
        summary: "创建 API Key",
        description: "创建新的 API Key，返回包含明文 key 的完整信息。",
      },
    },
  );

  // DELETE /web/api-keys/:id → 删除 API Key
  app.delete(
    "/api-keys/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ params, error: _error, request }: any) => {
      await deleteCallerApiKey({ headers: request.headers, keyId: params.id });
      // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
      return { success: true as const, data: { deleted: true as const } } as any;
    },
    {
      sessionAuth: true,
      response: {
        200: ApiKeyDeleteResponseSchema,
        400: WebErrSchema,
        403: WebErrSchema,
      },
      detail: {
        tags: ["Organizations"],
        summary: "删除 API Key",
        description: "删除指定的 API Key。",
      },
    },
  );

  // PUT /web/api-keys/:id → 更新 API Key
  app.put(
    "/api-keys/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ params, body, error: _error, request }: any) => {
      const b = body ?? {};
      await updateCallerApiKey({ headers: request.headers, id: params.id, name: b.name });
      // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
      return { success: true as const, data: null } as any;
    },
    {
      sessionAuth: true,
      body: UpdateApiKeyBodySchema,
      response: {
        200: ApiKeyVoidResponseSchema,
        400: WebErrSchema,
        403: WebErrSchema,
      },
      detail: {
        tags: ["Organizations"],
        summary: "更新 API Key",
        description: "更新指定 API Key 的名称或元数据。",
      },
    },
  );

  return app;
}
