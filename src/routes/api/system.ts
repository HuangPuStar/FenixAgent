import Elysia from "elysia";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import {
  type ApiSystemAddOrganizationMemberBody,
  ApiSystemAddOrganizationMemberBodySchema,
  ApiSystemApiKeyIdParamsSchema,
  ApiSystemApiKeyListResponseSchema,
  ApiSystemApiKeyResultSchema,
  type ApiSystemCreateApiKeyBody,
  ApiSystemCreateApiKeyBodySchema,
  type ApiSystemCreateOrganizationBody,
  ApiSystemCreateOrganizationBodySchema,
  type ApiSystemCreateUserBody,
  ApiSystemCreateUserBodySchema,
  ApiSystemDeleteResponseSchema,
  ApiSystemErrorResponseSchema,
  ApiSystemOrganizationDetailSchema,
  ApiSystemOrganizationIdParamsSchema,
  ApiSystemOrganizationListResponseSchema,
  ApiSystemOrganizationMemberSchema,
  type ApiSystemPaginationQuery,
  ApiSystemPaginationQuerySchema,
  ApiSystemUserIdParamsSchema,
  ApiSystemUserListResponseSchema,
  ApiSystemUserOrganizationListResponseSchema,
  ApiSystemUserSchema,
} from "../../schemas/api-system.schema";
import * as systemApi from "../../services/system-api";

function mapSystemApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("not found")) {
      return { status: 404, body: { error: { code: "NOT_FOUND", message: error.message } } };
    }
    if (lower.includes("already exists")) {
      return { status: 409, body: { error: { code: "CONFLICT", message: error.message } } };
    }
    return { status: 400, body: { error: { code: "BAD_REQUEST", message: error.message } } };
  }
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "Unknown error" } } };
}

function toDateTimeValue(value: Date | string | number | null | undefined) {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function toUserResponse(
  user: Awaited<ReturnType<typeof systemApi.getUserById>> extends infer T ? Exclude<T, null> : never,
) {
  return {
    ...user,
    createdAt: toDateTimeValue(user.createdAt),
    updatedAt: toDateTimeValue(user.updatedAt),
  };
}

function toOrganizationResponse<T extends { createdAt: Date | string | number }>(organization: T) {
  return {
    ...organization,
    createdAt: toDateTimeValue(organization.createdAt),
  };
}

function toOrganizationMemberResponse(member: Awaited<ReturnType<typeof systemApi.addOrganizationMember>>) {
  return {
    ...member,
    createdAt: toDateTimeValue(member.createdAt),
  };
}

function toApiKeyResponse(apiKey: Awaited<ReturnType<typeof systemApi.createUserApiKey>>) {
  return {
    ...apiKey,
    createdAt: toDateTimeValue(apiKey.createdAt),
    expiresAt: toDateTimeValue(apiKey.expiresAt),
  };
}

function toApiKeyListItemResponse(apiKey: Awaited<ReturnType<typeof systemApi.listUserApiKeys>>["items"][number]) {
  return {
    ...apiKey,
    createdAt: toDateTimeValue(apiKey.createdAt),
    expiresAt: toDateTimeValue(apiKey.expiresAt),
  };
}

function toUserOrganizationResponse(
  organization: Awaited<ReturnType<typeof systemApi.listUserOrganizations>>["items"][number],
) {
  return {
    ...toOrganizationResponse(organization),
    memberCreatedAt: toDateTimeValue(organization.memberCreatedAt),
  };
}

const app = new Elysia({ name: "api-system", prefix: "/api/system" }).use(systemApiAuthPlugin).model({
  "api-system-pagination-query": ApiSystemPaginationQuerySchema,
  "api-system-user-id-params": ApiSystemUserIdParamsSchema,
  "api-system-apikey-id-params": ApiSystemApiKeyIdParamsSchema,
  "api-system-create-user-body": ApiSystemCreateUserBodySchema,
  "api-system-user": ApiSystemUserSchema,
  "api-system-user-list-response": ApiSystemUserListResponseSchema,
  "api-system-user-organization-list-response": ApiSystemUserOrganizationListResponseSchema,
  "api-system-organization-id-params": ApiSystemOrganizationIdParamsSchema,
  "api-system-create-organization-body": ApiSystemCreateOrganizationBodySchema,
  "api-system-add-org-member-body": ApiSystemAddOrganizationMemberBodySchema,
  "api-system-organization-detail": ApiSystemOrganizationDetailSchema,
  "api-system-organization-list-response": ApiSystemOrganizationListResponseSchema,
  "api-system-organization-member": ApiSystemOrganizationMemberSchema,
  "api-system-create-api-key-body": ApiSystemCreateApiKeyBodySchema,
  "api-system-api-key-result": ApiSystemApiKeyResultSchema,
  "api-system-api-key-list-response": ApiSystemApiKeyListResponseSchema,
  "api-system-delete-response": ApiSystemDeleteResponseSchema,
});

app.get(
  "/users",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ query, error }: any) => {
    try {
      const result = await systemApi.listUsers(query as ApiSystemPaginationQuery);
      return {
        ...result,
        items: result.items.map((item) => toUserResponse(item)),
      };
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    query: "api-system-pagination-query",
    response: {
      200: "api-system-user-list-response",
      401: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System User"],
      summary: "获取用户列表",
      description: "系统级接口，返回平台内所有用户的稳定分页列表。",
    },
  },
);

app.delete(
  "/users/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, error }: any) => {
    try {
      return await systemApi.deleteUser(params.id);
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-user-id-params",
    response: {
      200: "api-system-delete-response",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System User"],
      summary: "删除用户",
      description: "系统级接口，删除指定用户，并清理其直接归属的用户 API key。",
    },
  },
);

app.post(
  "/users",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ body, error }: any) => {
    try {
      return toUserResponse(await systemApi.createUser(body as ApiSystemCreateUserBody));
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    body: "api-system-create-user-body",
    response: {
      200: "api-system-user",
      400: ApiSystemErrorResponseSchema,
      401: ApiSystemErrorResponseSchema,
      409: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System User"],
      summary: "创建用户",
      description: "系统级接口，创建平台用户并同步初始化 credential account 与个人组织。",
    },
  },
);

app.get(
  "/users/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, error }: any) => {
    try {
      const detail = await systemApi.getUserById(params.id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `User '${params.id}' not found` } });
      }
      return toUserResponse(detail);
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-user-id-params",
    response: {
      200: "api-system-user",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System User"],
      summary: "获取用户详情",
      description: "系统级接口，按用户 ID 返回单个用户详情。",
    },
  },
);

app.get(
  "/users/:id/api-keys",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, query, error }: any) => {
    try {
      const result = await systemApi.listUserApiKeys(params.id, query as ApiSystemPaginationQuery);
      return {
        ...result,
        items: result.items.map((item) => toApiKeyListItemResponse(item)),
      };
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-user-id-params",
    query: "api-system-pagination-query",
    response: {
      200: "api-system-api-key-list-response",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System ApiKey"],
      summary: "获取用户 API Key 列表",
      description: "系统级接口，按用户 ID 返回该用户名下的 API Key 分页列表，不返回明文 key。",
    },
  },
);

app.get(
  "/users/:id/organizations",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, query, error }: any) => {
    try {
      const result = await systemApi.listUserOrganizations(params.id, query as ApiSystemPaginationQuery);
      return {
        ...result,
        items: result.items.map((item) => toUserOrganizationResponse(item)),
      };
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-user-id-params",
    query: "api-system-pagination-query",
    response: {
      200: "api-system-user-organization-list-response",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Organization"],
      summary: "获取用户组织列表",
      description: "系统级接口，按用户 ID 返回该用户加入的组织分页列表，并附带该用户在组织中的角色信息。",
    },
  },
);

app.delete(
  "/organizations/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, error }: any) => {
    try {
      return await systemApi.deleteOrganization(params.id);
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-organization-id-params",
    response: {
      200: "api-system-delete-response",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Organization"],
      summary: "删除组织",
      description: "系统级接口，删除指定组织本体。当前不隐式清理所有文本 organizationId 引用资源。",
    },
  },
);

app.get(
  "/organizations",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ query, error }: any) => {
    try {
      const result = await systemApi.listOrganizations(query as ApiSystemPaginationQuery);
      return {
        ...result,
        items: result.items.map((item) => toOrganizationResponse(item)),
      };
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    query: "api-system-pagination-query",
    response: {
      200: "api-system-organization-list-response",
      401: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Organization"],
      summary: "获取组织列表",
      description: "系统级接口，返回平台内所有组织的稳定分页列表。",
    },
  },
);

app.post(
  "/organizations",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ body, error }: any) => {
    try {
      return toOrganizationResponse(await systemApi.createOrganization(body as ApiSystemCreateOrganizationBody));
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    body: "api-system-create-organization-body",
    response: {
      200: ApiSystemOrganizationDetailSchema.omit({ members: true }),
      400: ApiSystemErrorResponseSchema,
      401: ApiSystemErrorResponseSchema,
      409: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Organization"],
      summary: "创建组织",
      description: "系统级接口，创建组织，并可选地立即绑定 owner 用户。",
    },
  },
);

app.delete(
  "/api-keys/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, error }: any) => {
    try {
      return await systemApi.deleteUserApiKey(params.id);
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-apikey-id-params",
    response: {
      200: "api-system-delete-response",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System ApiKey"],
      summary: "删除用户 API Key",
      description: "系统级接口，按 API key ID 删除指定的用户级 API key。",
    },
  },
);

app.get(
  "/organizations/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, error }: any) => {
    try {
      const detail = await systemApi.getOrganizationById(params.id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Organization '${params.id}' not found` } });
      }
      return {
        ...toOrganizationResponse(detail),
        members: detail.members.map((item) => toOrganizationMemberResponse(item)),
      };
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-organization-id-params",
    response: {
      200: "api-system-organization-detail",
      401: ApiSystemErrorResponseSchema,
      404: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Organization"],
      summary: "获取组织详情",
      description: "系统级接口，按组织 ID 返回详情和成员列表。",
    },
  },
);

app.post(
  "/organizations/:id/members",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ params, body, error }: any) => {
    try {
      return toOrganizationMemberResponse(
        await systemApi.addOrganizationMember({
          organizationId: params.id,
          ...(body as ApiSystemAddOrganizationMemberBody),
        }),
      );
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    params: "api-system-organization-id-params",
    body: "api-system-add-org-member-body",
    response: {
      200: "api-system-organization-member",
      400: ApiSystemErrorResponseSchema,
      401: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System Organization"],
      summary: "添加组织成员",
      description: "系统级接口，将现有用户加入指定组织。",
    },
  },
);

app.post(
  "/api-keys",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia response schema + custom macro 下类型推断不稳定
  async ({ body, error }: any) => {
    try {
      return toApiKeyResponse(await systemApi.createUserApiKey(body as ApiSystemCreateApiKeyBody));
    } catch (err) {
      const mapped = mapSystemApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    systemApiKeyAuth: true,
    body: "api-system-create-api-key-body",
    response: {
      200: "api-system-api-key-result",
      400: ApiSystemErrorResponseSchema,
      401: ApiSystemErrorResponseSchema,
      500: ApiSystemErrorResponseSchema,
    },
    detail: {
      tags: ["System ApiKey"],
      summary: "代用户创建 API Key",
      description: "系统级接口，按指定 userId + organizationId + role 签发兼容现有 /api/* 的用户级 API key。",
    },
  },
);

export default app;
