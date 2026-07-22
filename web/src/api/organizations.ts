/**
 * organizations.ts — 组织域 API 模块
 *
 * 封装组织的 CRUD、成员管理、活跃组织切换等操作。
 * 后端提供 REST 风格路由：
 *   GET    /web/organizations              → 列表
 *   POST   /web/organizations              → 创建
 *   GET    /web/organizations/:id          → 详情（当前组织时含成员）
 *   PUT    /web/organizations/:id          → 更新
 *   DELETE /web/organizations/:id          → 删除
 *   POST   /web/organizations/:id/set-active → 设为活跃
 *   GET    /web/organizations/:id/members  → 成员列表
 *   POST   /web/organizations/:id/members  → 添加成员
 *   DELETE /web/organizations/:id/members/:memberId → 移除成员
 *   PUT    /web/organizations/:id/members/:memberId → 更新角色
 */

import { request } from "./request";

/** 组织基本信息 */
export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  /** better-auth 可能返回 ISO 时间字符串或 Unix 时间戳，对齐后端 FlexibleDateTimeSchema */
  createdAt: number | string;
}

/** 成员信息 */
export interface OrgMember {
  id: string;
  userId: string;
  role: string;
  /** 部分接口返回时可能不包含所属组织 ID，对齐后端 OrganizationMemberSchema */
  organizationId?: string;
  /** 成员关联的用户基础信息，对齐后端 OrganizationUserSchema */
  user?: { id: string; name: string; email: string; phoneNumber?: string | null };
}

/** 组织成员搜索候选项 */
export interface OrgMemberCandidate {
  id: string;
  name: string;
  email: string;
  phoneNumber?: string | null;
  isMember: boolean;
}

/** 组织详情（含成员列表） */
export interface OrgDetail extends OrgInfo {
  members?: OrgMember[];
  /** 与后端 OrganizationDetailSchema 匹配的扩展字段，包含 defaultEngine 等 */
  metadata?: Record<string, unknown> | null;
}

/** 创建组织请求体 */
export interface CreateOrgBody {
  name: string;
  /** 必填，对齐后端 CreateOrganizationBodySchema 强制要求 slug */
  slug: string;
}

/** 更新组织请求体（字段可选） */
export type UpdateOrgBody = Partial<CreateOrgBody>;

/** 添加成员请求体 */
export interface AddMemberBody {
  userIds?: string[];
  role: string;
}

/** 删除结果响应，对齐后端返回 { success: true, data: { deleted: true } } */
export interface DeleteResult {
  deleted: true;
}

export const orgApi = {
  /** 获取当前用户所属的全部组织列表 */
  list: () =>
    request<Array<{ id: string; name: string; slug: string; role: string }>>("/web/organizations", {
      method: "GET",
    }),

  /** 根据组织 ID 获取组织详情（当前组织时含成员列表） */
  get: (orgId: string) =>
    request<OrgDetail>("/web/organizations/:id", {
      method: "GET",
      params: { id: orgId },
    }),

  /** 创建新组织 */
  create: (body: CreateOrgBody) =>
    request<OrgInfo>("/web/organizations", {
      method: "POST",
      body: { name: body.name, slug: body.slug },
    }),

  /** 更新已有组织信息 */
  update: (orgId: string, body: UpdateOrgBody) =>
    request<OrgInfo>("/web/organizations/:id", {
      method: "PUT",
      params: { id: orgId },
      body: { name: body.name, slug: body.slug },
    }),

  /** 删除指定组织 */
  del: (orgId: string) =>
    request<DeleteResult>("/web/organizations/:id", {
      method: "DELETE",
      params: { id: orgId },
    }),

  /** 将指定组织设为当前活跃组织 */
  setActive: (orgId: string) =>
    request<void>("/web/organizations/:id/set-active", {
      method: "POST",
      params: { id: orgId },
    }),

  /** 获取指定组织的成员列表 */
  listMembers: (orgId: string) =>
    request<OrgMember[]>("/web/organizations/:id/members", {
      method: "GET",
      params: { id: orgId },
    }),

  /** 搜索指定组织可添加的成员候选项 */
  searchMemberCandidates: (orgId: string, keyword: string) =>
    request<OrgMemberCandidate[]>("/web/organizations/:id/member-candidates", {
      method: "GET",
      params: { id: orgId },
      query: { keyword },
    }),

  /** 向指定组织添加新成员（支持邮箱或手机号） */
  addMember: (orgId: string, body: AddMemberBody) =>
    request<OrgMember[]>("/web/organizations/:id/members", {
      method: "POST",
      params: { id: orgId },
      body: { userIds: body.userIds, role: body.role },
    }),

  /** 从指定组织中移除成员 */
  removeMember: (orgId: string, memberId: string) =>
    request<void>("/web/organizations/:id/members/:memberId", {
      method: "DELETE",
      params: { id: orgId, memberId },
    }),

  /** 更新指定组织中某成员的角色 */
  updateRole: (orgId: string, memberId: string, role: string) =>
    request<void>("/web/organizations/:id/members/:memberId", {
      method: "PUT",
      params: { id: orgId, memberId },
      body: { role },
    }),

  /** 更新组织 metadata（透传给 better-auth 底层），用于设置默认引擎等 */
  updateMetadata: (orgId: string, data: Record<string, unknown>) =>
    request<OrgInfo>("/web/organizations/:id", {
      method: "PUT",
      params: { id: orgId },
      body: { data },
    }),
};
