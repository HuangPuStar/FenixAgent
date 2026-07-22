import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema } from "../../schemas/common.schema";
import {
  AddMemberBodySchema,
  CreateOrganizationBodySchema,
  MemberCandidateListResponseSchema,
  MemberListResponseSchema,
  MemberMutateResponseSchema,
  OrganizationDeleteResponseSchema,
  OrganizationGetResponseSchema,
  OrganizationListResponseSchema,
  OrganizationMutateResponseSchema,
  OrganizationVoidResponseSchema,
  SearchMemberCandidatesQuerySchema,
  UpdateMemberRoleBodySchema,
  UpdateOrganizationBodySchema,
} from "../../schemas/organization.schema";
import {
  addOrganizationMembers,
  enrichMembersWithPhoneNumbers,
  enrichOrganizationsWithRoles,
  searchAvailableOrganizationMemberCandidates,
} from "../../services/web-organization-service";

const app = new Elysia({ name: "web-organizations" }).use(authGuardPlugin).model({
  "org-list-response": OrganizationListResponseSchema,
  "org-get-response": OrganizationGetResponseSchema,
  "org-mutate-response": OrganizationMutateResponseSchema,
  "org-delete-response": OrganizationDeleteResponseSchema,
  "org-void-response": OrganizationVoidResponseSchema,
  "member-list-response": MemberListResponseSchema,
  "member-candidate-list-response": MemberCandidateListResponseSchema,
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

/** 统一抽取 better-auth 返回的成员列表。 */
function extractMembers(res: unknown): {
  id: string;
  userId: string;
  role: string;
  user?: { id: string; name: string; email: string; phoneNumber?: string | null };
}[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && "members" in res)
    return (
      res as {
        members: Array<{
          id: string;
          userId: string;
          role: string;
          user?: { id: string; name: string; email: string; phoneNumber?: string | null };
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
  const enriched = await enrichOrganizationsWithRoles(userId as string, orgs as Array<Record<string, unknown>>);
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
      const memberList = await enrichMembersWithPhoneNumbers(extractMembers(members));
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

// POST /web/organizations → 创建组织
app.post(
  "/organizations",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ body, request }: any) => {
    const b = body as { name: string; slug: string; description?: string };
    const metadata: Record<string, unknown> = {};
    if (b.description) metadata.description = b.description;
    const org = await api.createOrganization({
      body: { name: b.name, slug: b.slug, metadata },
      headers: request.headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: normalizeDateValue(org) } as any;
  },
  {
    sessionAuth: true,
    body: CreateOrganizationBodySchema,
    response: {
      200: OrganizationMutateResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "创建组织",
      description: "创建新的组织，创建者自动成为 owner。",
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
    const memberData = await enrichMembersWithPhoneNumbers(extractMembers(members));
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

// GET /web/organizations/:id/member-candidates → 搜索可添加成员候选项
app.get(
  "/organizations/:id/member-candidates",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ params, query }: any) => {
    const keyword = String(query?.keyword ?? "").trim();
    if (!keyword) {
      // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
      return { success: true as const, data: [] } as any;
    }
    const candidates = await searchAvailableOrganizationMemberCandidates(params.id, keyword);

    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    return { success: true as const, data: candidates } as any;
  },
  {
    sessionAuth: true,
    query: SearchMemberCandidatesQuerySchema,
    response: {
      200: MemberCandidateListResponseSchema,
      400: WebErrSchema,
      403: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Organizations"],
      summary: "搜索组织成员候选项",
      description: "按姓名、邮箱或手机号搜索全站用户，并标记其是否已在当前组织中。",
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
    const directUserIds = Array.isArray(b.userIds)
      ? b.userIds.map((item: unknown) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [];
    if (directUserIds.length === 0) {
      return error(400, {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "userIds required" },
      });
    }
    const result = await addOrganizationMembers(params.id, directUserIds, b.role, request.headers);
    return {
      success: true as const,
      data: normalizeDateValue(result),
    };
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
      description: "向指定组织添加新成员，支持通过邮箱或手机号指定用户。",
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
