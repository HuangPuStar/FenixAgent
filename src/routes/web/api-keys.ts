import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import {
  ApiKeyCreateResponseSchema,
  ApiKeyDeleteResponseSchema,
  ApiKeyListResponseSchema,
  ApiKeyVoidResponseSchema,
  CreateApiKeyBodySchema,
  UpdateApiKeyBodySchema,
} from "../../schemas/organization.schema";

const app = new Elysia({ name: "web-api-keys" }).use(authGuardPlugin).model({
  "apikey-list-response": ApiKeyListResponseSchema,
  "apikey-create-response": ApiKeyCreateResponseSchema,
  "apikey-delete-response": ApiKeyDeleteResponseSchema,
  "apikey-void-response": ApiKeyVoidResponseSchema,
});

// 窄化 better-auth API 类型
interface OrgApi {
  listApiKeys: (opts: { headers: Headers }) => Promise<unknown>;
  createApiKey: (opts: {
    body: {
      name: string;
      prefix: string;
      expiresIn: number | null;
      metadata: unknown;
    };
    headers: Headers;
  }) => Promise<unknown>;
  deleteApiKey: (opts: { body: { keyId: string }; headers: Headers }) => Promise<void>;
  updateApiKey: (opts: { body: { id: string; name?: string }; headers: Headers }) => Promise<void>;
}

const api = auth.api as unknown as OrgApi;

interface ApiKeyListResult {
  apiKeys?: unknown[];
}

interface ApiKeyRecord {
  name?: unknown;
}

function extractApiKeys(result: unknown): ApiKeyRecord[] {
  if (Array.isArray(result)) return result as ApiKeyRecord[];
  if (result && typeof result === "object" && Array.isArray((result as ApiKeyListResult).apiKeys)) {
    return (result as ApiKeyListResult).apiKeys as ApiKeyRecord[];
  }
  return [];
}

function normalizeApiKeyName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

function normalizeDateValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeDateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeDateValue(nested)]),
    );
  }
  return value;
}

/**
 * 构造 API key metadata。
 * 页面创建的 key 必须继承当前组织和角色，才能在后续纯 API key 的 HTTP 调用里
 * 从 apikey 记录恢复出一致的组织上下文。
 */
function buildApiKeyMetadata(
  metadata: unknown,
  authContext: { organizationId: string; role: string },
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  return {
    ...base,
    organizationId: authContext.organizationId,
    role: authContext.role,
  };
}

// ────────────────────────────────────────────
// REST API Key 路由
// ────────────────────────────────────────────

// GET /web/api-keys → 获取 API Key 列表
app.get(
  "/api-keys",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ request }: any) => {
    const result = (await api.listApiKeys({ headers: request.headers })) as {
      apiKeys?: unknown[];
    } | null;
    const keys = Array.isArray(result?.apiKeys) ? result.apiKeys : Array.isArray(result) ? result : [];
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: normalizeDateValue(keys) } as any;
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
    const existingApiKeys = extractApiKeys(await api.listApiKeys({ headers: request.headers }));
    const duplicatedName = existingApiKeys.some((apiKey) => normalizeApiKeyName(apiKey.name) === normalizedName);
    if (duplicatedName) {
      return error(400, {
        success: false,
        error: { code: "DUPLICATE_API_KEY_NAME", message: "API key name already exists" },
      });
    }
    const result = await api.createApiKey({
      body: {
        name: normalizedName,
        prefix: "rcs_",
        expiresIn: b.expiresAt ? Math.ceil((new Date(b.expiresAt).getTime() - Date.now()) / 1000) : null,
        metadata: buildApiKeyMetadata(b.metadata, authContext),
      },
      headers: request.headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: normalizeDateValue(result) } as any;
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
    await api.deleteApiKey({ body: { keyId: params.id }, headers: request.headers });
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
    await api.updateApiKey({ body: { id: params.id, name: b.name }, headers: request.headers });
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

export default app;
