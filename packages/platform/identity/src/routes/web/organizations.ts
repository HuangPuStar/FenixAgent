import { type ActorContext, WebErrSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import type * as z from "zod/v4";
import { getAuth } from "../../auth/better-auth";
import { OrganizationMemberManagementFacade } from "../../facades/organization-member-management-facade";
import {
  AddMemberBodySchema,
  CreateOrganizationBodySchema,
  MemberCandidateListResponseSchema,
  MemberListResponseSchema,
  MemberMutateResponseSchema,
  OrganizationDeleteResponseSchema,
  type OrganizationDetail,
  OrganizationGetResponseSchema,
  type OrganizationInfo,
  OrganizationListResponseSchema,
  type OrganizationMember,
  OrganizationMutateResponseSchema,
  OrganizationVoidResponseSchema,
  SearchMemberCandidatesQuerySchema,
  UpdateMemberRoleBodySchema,
  UpdateOrganizationBodySchema,
} from "../../schemas/organization.schema";
import { enrichMembersWithPhoneNumbers, enrichOrganizationsWithRoles } from "../../services/web-organization-service";
import type { WebIdentityRouteDependencies } from "../dependencies";

/**
 * `/web/organizations` 路由（CE 阶段 2 任务 1.2）。
 *
 * 从 `packages/resources/identity-admin` 迁入并改为工厂：守卫由宿主注入，理由见 `../dependencies`。
 *
 * better-auth 实例改为 `getAuth()` 惰性取得。原因是实例构造依赖宿主完成基础设施初始化
 * （`getDatabase()` 与 `getModuleConfig("identity")`），在模块加载期固化会让导入顺序变成隐式启动依赖；
 * 迁出宿主后本模块不再能假设自己是在 `initializeApplicationInfrastructure()` 之后被导入的。
 */

type BetterAuthMember = {
  id: string;
  userId: string;
  role: string;
  organizationId?: string;
  createdAt?: string | number | Date;
  user?: { id: string; name: string; email: string; phoneNumber?: string | null; image?: string | null };
};

type BetterAuthMemberListResponse = BetterAuthMember[] | { members: BetterAuthMember[] };

type BetterAuthOrganization = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string | number | Date;
  members?: BetterAuthMember[];
  [key: string]: unknown;
};

// 窄化 better-auth API 类型，仅暴露本文件使用的方法
interface OrgApi {
  listOrganizations: (opts: { headers: Headers }) => Promise<BetterAuthOrganization[]>;
  getFullOrganization: (opts: {
    query: { organizationId: string };
    headers: Headers;
  }) => Promise<BetterAuthOrganization>;
  listMembers: (opts: { query: { organizationId: string }; headers: Headers }) => Promise<BetterAuthMemberListResponse>;
  createOrganization: (opts: {
    body: { name: string; slug: string; metadata?: Record<string, unknown> };
    headers: Headers;
  }) => Promise<BetterAuthOrganization>;
  updateOrganization: (opts: {
    body: { data: Record<string, unknown>; organizationId: string };
    headers: Headers;
  }) => Promise<BetterAuthOrganization>;
  deleteOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  setActiveOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  removeMember: (opts: {
    body: { memberIdOrEmail: string; organizationId?: string };
    headers: Headers;
  }) => Promise<void>;
  addMember: (opts: {
    body: { userId: string; role: string; organizationId: string };
    headers: Headers;
  }) => Promise<BetterAuthMember>;
  updateMemberRole: (opts: {
    body: { memberId: string; organizationId?: string; role: string };
    headers: Headers;
  }) => Promise<void>;
}

function orgApi(): OrgApi {
  return getAuth().api as unknown as OrgApi;
}

type AuthStore = {
  user?: { id: string } | null;
  authContext?: { organizationId?: string } | null;
  actor?: ActorContext | null;
};

type OrganizationListResponse = z.infer<typeof OrganizationListResponseSchema>;
type OrganizationGetResponse = z.infer<typeof OrganizationGetResponseSchema>;
type OrganizationMutateResponse = z.infer<typeof OrganizationMutateResponseSchema>;
type OrganizationDeleteResponse = z.infer<typeof OrganizationDeleteResponseSchema>;
type OrganizationVoidResponse = z.infer<typeof OrganizationVoidResponseSchema>;
type MemberListResponse = z.infer<typeof MemberListResponseSchema>;
type MemberCandidateListResponse = z.infer<typeof MemberCandidateListResponseSchema>;
type MemberMutateResponse = z.infer<typeof MemberMutateResponseSchema>;

function toFlexibleDateTime(value: string | number | Date): string | number {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeMember(member: BetterAuthMember): OrganizationMember {
  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    organizationId: member.organizationId,
    user: member.user
      ? {
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
          phoneNumber: member.user.phoneNumber ?? null,
        }
      : undefined,
  };
}

function serializeOrganizationInfo(organization: BetterAuthOrganization & { role?: string }): OrganizationInfo {
  return {
    ...organization,
    createdAt: toFlexibleDateTime(organization.createdAt),
    role: organization.role,
  };
}

function serializeOrganizationDetail(
  organization: BetterAuthOrganization,
  members: BetterAuthMember[],
): OrganizationDetail {
  return {
    ...serializeOrganizationInfo(organization),
    members: members.map(serializeMember),
  };
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

/** `sessionAuth` 负责写入 actor；缺失说明路由装配或认证守卫出现了故障，不能退化为放行。 */
function requireActor(store: AuthStore): ActorContext {
  if (!store.actor) throw new Error("认证主体缺失：组织成员管理需要 sessionAuth actor");
  return store.actor;
}

// 共享的 list organizations 逻辑（REST 路由复用）
async function handleListOrganizations(
  store: { user?: { id: string } | null },
  request: Request,
): Promise<OrganizationListResponse> {
  const orgs = await orgApi().listOrganizations({ headers: request.headers });
  if (!Array.isArray(orgs) || orgs.length === 0) {
    return { success: true as const, data: [] } satisfies OrganizationListResponse;
  }
  const userId = store.user?.id;
  const enriched = userId
    ? await enrichOrganizationsWithRoles(userId, orgs)
    : orgs.map((org) => ({ ...org, role: "member" }));
  return { success: true as const, data: enriched.map(serializeOrganizationInfo) } satisfies OrganizationListResponse;
}

/**
 * `/web/organizations` 路由工厂。
 *
 * 守卫由宿主注入：`authGuardPlugin` 提供的 `sessionAuth` macro 与 `store.authContext` 必须与宿主
 * 的认证解析是同一份实例，理由见 `../dependencies`。
 */
export function createWebOrganizationsRoutes(deps: WebIdentityRouteDependencies) {
  const memberManagement = new OrganizationMemberManagementFacade({});
  const app = new Elysia({ name: "web-organizations" }).use(deps.authGuardPlugin).model({
    "org-list-response": OrganizationListResponseSchema,
    "org-get-response": OrganizationGetResponseSchema,
    "org-mutate-response": OrganizationMutateResponseSchema,
    "org-delete-response": OrganizationDeleteResponseSchema,
    "org-void-response": OrganizationVoidResponseSchema,
    "member-list-response": MemberListResponseSchema,
    "member-candidate-list-response": MemberCandidateListResponseSchema,
    "member-mutate-response": MemberMutateResponseSchema,
  });

  // ── RESTful Organization 路由 ──

  // GET /web/organizations → 获取组织列表
  app.get(
    "/organizations",
    async ({ request, store }) => {
      return handleListOrganizations(store as AuthStore, request);
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
    async ({ params, request, store }) => {
      const authStore = store as AuthStore;
      const orgId = params.id;
      const authCtx = authStore.authContext;
      const isCurrentOrg = authCtx?.organizationId === orgId;
      if (isCurrentOrg) {
        const [org, members] = await Promise.all([
          orgApi().getFullOrganization({ query: { organizationId: orgId }, headers: request.headers }),
          orgApi().listMembers({ query: { organizationId: orgId }, headers: request.headers }),
        ]);
        const memberList = await enrichMembersWithPhoneNumbers(extractMembers(members));
        return {
          success: true as const,
          data: serializeOrganizationDetail(org, memberList),
        } satisfies OrganizationGetResponse;
      }
      const org = await orgApi().getFullOrganization({ query: { organizationId: orgId }, headers: request.headers });
      return { success: true as const, data: serializeOrganizationInfo(org) } satisfies OrganizationGetResponse;
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
    async ({ body, request }) => {
      const b = body;
      const metadata: Record<string, unknown> = {};
      if (b.description) metadata.description = b.description;
      const org = await orgApi().createOrganization({
        body: { name: b.name, slug: b.slug, metadata },
        headers: request.headers,
      });
      return { success: true as const, data: serializeOrganizationInfo(org) } satisfies OrganizationMutateResponse;
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
    async ({ body, params, request }) => {
      const b = body ?? {};
      const updateData: Record<string, unknown> = b.data ?? {};
      if (!b.data) {
        if (b.name) updateData.name = b.name;
        if (b.slug) updateData.slug = b.slug;
      }
      const org = await orgApi().updateOrganization({
        body: { data: updateData, organizationId: params.id },
        headers: request.headers,
      });
      return { success: true as const, data: serializeOrganizationInfo(org) } satisfies OrganizationMutateResponse;
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
    async ({ params, request }) => {
      await orgApi().deleteOrganization({ body: { organizationId: params.id }, headers: request.headers });
      return { success: true as const, data: { deleted: true as const } } satisfies OrganizationDeleteResponse;
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
    async ({ params, request }) => {
      await orgApi().setActiveOrganization({ body: { organizationId: params.id }, headers: request.headers });
      return { success: true as const, data: null } satisfies OrganizationVoidResponse;
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
    async ({ params, request }) => {
      const members = await orgApi().listMembers({
        query: { organizationId: params.id },
        headers: request.headers,
      });
      const memberData = await enrichMembersWithPhoneNumbers(extractMembers(members));
      return { success: true as const, data: memberData.map(serializeMember) } satisfies MemberListResponse;
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
    async ({ params, query, store }) => {
      const keyword = String(query?.keyword ?? "").trim();
      const candidates = await memberManagement.searchCandidates(requireActor(store as AuthStore), params.id, keyword);

      return { success: true as const, data: candidates } satisfies MemberCandidateListResponse;
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
    async ({ body, params, request, store }) => {
      const directUserIds = body.userIds.map((userId: string) => userId.trim()).filter(Boolean);
      const result = await memberManagement.addMembers(
        requireActor(store as AuthStore),
        params.id,
        directUserIds,
        body.role,
        request.headers,
      );
      return {
        success: true as const,
        data: result.map(serializeMember),
      } satisfies MemberMutateResponse;
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
    async ({ params, request }) => {
      await orgApi().removeMember({
        body: { memberIdOrEmail: params.memberId, organizationId: params.id },
        headers: request.headers,
      });
      return { success: true as const, data: null } satisfies OrganizationVoidResponse;
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
    async ({ body, params, request, store }) => {
      await memberManagement.updateMemberRole(
        requireActor(store as AuthStore),
        params.id,
        params.memberId,
        body.role,
        request.headers,
      );
      return { success: true as const, data: null } satisfies OrganizationVoidResponse;
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

  return app;
}
