/**
 * organizations.ts — 组织域 API 模块
 *
 * 封装组织的 CRUD、成员管理、活跃组织切换等操作。
 * 后端使用 POST /web/organizations 的 action 分发模式，域模块内部抽象为具名方法。
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
  user?: { id: string; name: string; email: string };
}

/** 组织详情（含成员列表） */
export interface OrgDetail extends OrgInfo {
  members?: OrgMember[];
}

/** 创建组织请求体 */
export interface CreateOrgBody {
  name: string;
  /** 必填，对齐后端 CreateOrganizationActionSchema 强制要求 slug */
  slug: string;
}

/** 更新组织请求体（字段可选） */
export type UpdateOrgBody = Partial<CreateOrgBody>;

/** 添加成员请求体 */
export interface AddMemberBody {
  email: string;
  role: string;
}

/** 活跃组织切换响应 */
export interface SetActiveResult {
  success: boolean;
}

/** 删除结果响应，对齐后端 case "delete" 返回 { success: true, data: { deleted: true } } */
export interface DeleteResult {
  deleted: true;
}

export const orgApi = {
  /** 获取当前用户所属的全部组织列表 */
  list: () =>
    request<Array<{ id: string; name: string; slug: string; role: string }>>("/web/organizations", {
      method: "POST",
      body: { action: "list" },
    }),

  /** 根据组织 ID 获取组织详情（含成员列表） */
  get: (orgId: string) =>
    request<OrgDetail>("/web/organizations", {
      method: "POST",
      body: { action: "get", organizationId: orgId },
    }),

  /** 根据组织 ID 获取组织完整信息（含成员列表等扩展字段） */
  getFull: (orgId: string) =>
    request<OrgDetail>("/web/organizations", {
      method: "POST",
      body: { action: "get-full", organizationId: orgId },
    }),

  /** 创建新组织 */
  create: (body: CreateOrgBody) =>
    request<OrgInfo>("/web/organizations", {
      method: "POST",
      body: { action: "create", name: body.name, slug: body.slug },
    }),

  /** 更新已有组织信息 */
  update: (orgId: string, body: UpdateOrgBody) =>
    request<OrgInfo>("/web/organizations", {
      method: "POST",
      body: { action: "update", organizationId: orgId, data: body },
    }),

  /** 删除指定组织 */
  del: (orgId: string) =>
    request<DeleteResult>("/web/organizations", {
      method: "POST",
      body: { action: "delete", organizationId: orgId },
    }),

  /** 将指定组织设为当前活跃组织 */
  setActive: (orgId: string) =>
    request<SetActiveResult>("/web/organizations", {
      method: "POST",
      body: { action: "set-active", organizationId: orgId },
    }),

  /** 获取指定组织的成员列表 */
  listMembers: (orgId: string) =>
    request<OrgMember[]>("/web/organizations", {
      method: "POST",
      body: { action: "list-members", organizationId: orgId },
    }),

  /** 向指定组织添加新成员（通过邮箱邀请） */
  addMember: (orgId: string, body: AddMemberBody) =>
    request<OrgMember>("/web/organizations", {
      method: "POST",
      body: { action: "add-member", organizationId: orgId, email: body.email, role: body.role },
    }),

  /** 从指定组织中移除成员，后端返回 { success: true }（无 data 字段） */
  removeMember: (orgId: string, memberId: string) =>
    request<SetActiveResult>("/web/organizations", {
      method: "POST",
      body: { action: "remove-member", organizationId: orgId, memberId },
    }),

  /** 更新指定组织中某成员的角色，后端返回 { success: true }（无 data 字段） */
  updateRole: (orgId: string, memberId: string, role: string) =>
    request<SetActiveResult>("/web/organizations", {
      method: "POST",
      body: { action: "update-role", organizationId: orgId, memberId, role },
    }),
};
