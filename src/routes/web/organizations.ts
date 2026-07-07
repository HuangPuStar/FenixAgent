import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { db } from "../../db";
import { member, user } from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import {
  AddMemberBodySchema,
  MemberListResponseSchema,
  MemberMutateResponseSchema,
  OrganizationDeleteResponseSchema,
  OrganizationGetResponseSchema,
  OrganizationListResponseSchema,
  OrganizationMutateResponseSchema,
  OrganizationVoidResponseSchema,
  UpdateMemberRoleBodySchema,
  UpdateOrganizationBodySchema,
} from "../../schemas/organization.schema";

const app = new Elysia({ name: "web-organizations" }).use(authGuardPlugin).model({
  "org-list-response": OrganizationListResponseSchema,
  "org-get-response": OrganizationGetResponseSchema,
  "org-mutate-response": OrganizationMutateResponseSchema,
  "org-delete-response": OrganizationDeleteResponseSchema,
  "org-void-response": OrganizationVoidResponseSchema,
  "member-list-response": MemberListResponseSchema,
  "member-mutate-response": MemberMutateResponseSchema,
});

// 窄化 better-auth API 类型，仅暴露本文件使用的方法
interface OrgApi {
  listOrganizations: (opts: { headers: Headers }) => Promise<unknown>;
  getFullOrganization: (opts: { query: { organizationId: string }; headers: Headers }) => Promise<unknown>;
  listMembers: (opts: { query: { organizationId: string }; headers: Headers }) => Promise<unknown>;
  createOrganization: (opts: {
    body: { name: string; slug: string; metadata?: Record<string, unknown> };
    headers: Headers;
  }) => Promise<unknown>;
  updateOrganization: (opts: {
    body: { data: Record<string, unknown>; organizationId: string };
    headers: Headers;
  }) => Promise<unknown>;
  deleteOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  setActiveOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  removeMember: (opts: {
    body: { memberIdOrEmail: string; organizationId?: string };
    headers: Headers;
  }) => Promise<void>;
  addMember: (opts: {
    body: { userId: string; role: string; organizationId: string };
    headers: Headers;
  }) => Promise<unknown>;
  updateMemberRole: (opts: {
    body: { memberId: string; organizationId?: string; role: string };
    headers: Headers;
  }) => Promise<void>;
}

const api = auth.api as unknown as OrgApi;

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
 * 普通页面创建的 key 必须继承当前组织和角色，才能在后续纯 API key 的 HTTP 调用里
 * 从 apikey 记录恢复出一致的组织上下文；仅靠 referenceId 只能定位“归属哪个用户”，
 * 但无法知道应该以哪个组织、哪个角色访问多租户资源。
 */
function extractMembers(
  res: unknown,
): { id: string; userId: string; role: string; user?: { id: string; name: string; email: string } }[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && "members" in res)
    return (
      res as {
        members: Array<{
          id: string;
          userId: string;
          role: string;
          user?: { id: string; name: string; email: string };
        }>;
      }
    ).members;
  return [];
}

// 共享的 list organizations 逻辑（REST 路由复用）
async function handleListOrganizations(store: { user?: { id: string } }, request: { headers: Headers }) {
  const orgs = await api.listOrganizations({ headers: request.headers });
  if (!Array.isArray(orgs) || orgs.length === 0) {
    return { success: true as const, data: [] as unknown[] };
  }
  const userId = store.user?.id;
  const memberships = await db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId as string))
    .execute();
  const roleMap = new Map(memberships.map((m) => [m.organizationId, m.role]));
  const enriched = orgs.map((o: Record<string, unknown>) => ({
    ...o,
    role: roleMap.get(o.id as string) ?? "member",
  }));
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  return { success: true as const, data: normalizeDateValue(enriched) } as any;
}

// ── RESTful Organization 路由 ──

// GET /web/organizations → 获取组织列表
app.get(
  "/organizations",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, request }: any) => {
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return handleListOrganizations(store, request) as any;
  },
  {
    sessionAuth: true,
    response: {
      200: OrganizationListResponseSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "获取组织列表",
      description: "返回当前用户所属的全部组织，并补充角色信息。",
    },
  },
);

// GET /web/organizations/:id → 获取组织详情（当前组织时含成员列表）
app.get(
  "/organizations/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, request }: any) => {
    const orgId = params.id;
    const authCtx = store.authContext;
    const isCurrentOrg = authCtx?.organizationId === orgId;
    if (isCurrentOrg) {
      const [org, members] = await Promise.all([
        api.getFullOrganization({ query: { organizationId: orgId }, headers: request.headers }),
        api.listMembers({ query: { organizationId: orgId }, headers: request.headers }),
      ]);
      const memberList = extractMembers(members);
      return {
        success: true as const,
        data: normalizeDateValue({ ...(org as Record<string, unknown>), members: memberList }),
        // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
      } as any;
    }
    const org = await api.getFullOrganization({ query: { organizationId: orgId }, headers: request.headers });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: normalizeDateValue(org) } as any;
  },
  {
    sessionAuth: true,
    response: {
      200: OrganizationGetResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "获取组织详情",
      description: "返回指定组织的详细信息；当请求的组织为当前活跃组织时，额外包含成员列表。",
    },
  },
);

// PUT /web/organizations/:id → 更新组织
app.put(
  "/organizations/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, body, request }: any) => {
    const b = body ?? {};
    const updateData: Record<string, unknown> = b.data ?? {};
    if (!b.data) {
      if (b.name) updateData.name = b.name;
      if (b.slug) updateData.slug = b.slug;
    }
    const org = await api.updateOrganization({
      body: { data: updateData, organizationId: params.id },
      headers: request.headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: normalizeDateValue(org) } as any;
  },
  {
    sessionAuth: true,
    body: UpdateOrganizationBodySchema,
    response: {
      200: OrganizationMutateResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "更新组织",
      description: "更新指定组织的信息，支持更新名称、slug 或透传原始数据。",
    },
  },
);

// DELETE /web/organizations/:id → 删除组织
app.delete(
  "/organizations/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, request }: any) => {
    await api.deleteOrganization({ body: { organizationId: params.id }, headers: request.headers });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: { deleted: true as const } } as any;
  },
  {
    sessionAuth: true,
    response: {
      200: OrganizationDeleteResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "删除组织",
      description: "删除指定组织及其关联数据。",
    },
  },
);

// POST /web/organizations/:id/set-active → 设置活跃组织
app.post(
  "/organizations/:id/set-active",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, request }: any) => {
    await api.setActiveOrganization({ body: { organizationId: params.id }, headers: request.headers });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: null } as any;
  },
  {
    sessionAuth: true,
    response: {
      200: OrganizationVoidResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "设置活跃组织",
      description: "将当前用户的活跃组织切换为指定组织。",
    },
  },
);

// GET /web/organizations/:id/members → 获取成员列表
app.get(
  "/organizations/:id/members",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, request }: any) => {
    const members = await api.listMembers({
      query: { organizationId: params.id },
      headers: request.headers,
    });
    const memberData = extractMembers(members);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: memberData } as any;
  },
  {
    sessionAuth: true,
    response: {
      200: MemberListResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "获取组织成员列表",
      description: "返回指定组织的所有成员及其角色信息。",
    },
  },
);

// POST /web/organizations/:id/members → 添加成员
app.post(
  "/organizations/:id/members",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, body, error, request }: any) => {
    const b = body ?? {};
    if (!b.role) {
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "role required" } });
    }
    let memberUserId: string | undefined;
    const rawId = (b.userId ?? b.email) as string | undefined;
    if (!rawId) {
      return error(400, {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "userId or email required" },
      });
    }
    if (rawId.includes("@")) {
      const [foundUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, rawId)).limit(1);
      if (!foundUser)
        return error(404, { success: false, error: { code: "USER_NOT_FOUND", message: "该邮箱用户不存在" } });
      memberUserId = foundUser.id;
    } else {
      memberUserId = rawId;
    }
    const result = await api.addMember({
      body: { userId: memberUserId, role: b.role, organizationId: params.id },
      headers: request.headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: normalizeDateValue(result) } as any;
  },
  {
    sessionAuth: true,
    body: AddMemberBodySchema,
    response: {
      200: MemberMutateResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "添加组织成员",
      description: "向指定组织添加新成员，支持通过 userId 或邮箱指定用户。",
    },
  },
);

// DELETE /web/organizations/:id/members/:memberId → 移除成员
app.delete(
  "/organizations/:id/members/:memberId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, request }: any) => {
    await api.removeMember({
      body: { memberIdOrEmail: params.memberId, organizationId: params.id },
      headers: request.headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: null } as any;
  },
  {
    sessionAuth: true,
    response: {
      200: OrganizationVoidResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "移除组织成员",
      description: "从指定组织中移除某成员。",
    },
  },
);

// PUT /web/organizations/:id/members/:memberId → 更新成员角色
app.put(
  "/organizations/:id/members/:memberId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, body, error, request }: any) => {
    const b = body ?? {};
    if (!b.role) {
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "role required" } });
    }
    await api.updateMemberRole({
      body: { memberId: params.memberId, organizationId: params.id, role: b.role },
      headers: request.headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: null } as any;
  },
  {
    sessionAuth: true,
    body: UpdateMemberRoleBodySchema,
    response: {
      200: OrganizationVoidResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "更新成员角色",
      description: "更新指定组织中某成员的角色。",
    },
  },
);

export default app;
