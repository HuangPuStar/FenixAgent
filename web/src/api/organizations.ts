/**
 * organizations.ts — 组织域 API 模块
 *
 * 封装组织的 CRUD、成员管理、活跃组织切换等操作，采用 RESTful 风格，
 * 统一通过 request() 与后端 /web/organizations 通信。
 */

import { request } from "./request";

/** 组织基本信息 */
export interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}

/** 成员信息 */
export interface OrgMember {
  id: string;
  userId: string;
  role: string;
  organizationId: string;
}

/** 组织详情（含成员列表） */
export interface OrgDetail extends OrgInfo {
  members?: OrgMember[];
}

/** 创建组织请求体 */
export interface CreateOrgBody {
  name: string;
  slug?: string;
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

/** 删除结果响应 */
export interface DeleteResult {
  success: boolean;
}

export const orgApi = {
  /** 获取当前用户所属的全部组织列表 */
  list: () => request<OrgInfo[]>("/web/organizations", { method: "GET" }),

  /** 根据组织 ID 获取组织详情 */
  get: (orgId: string) =>
    request<OrgDetail>("/web/organizations/:orgId", {
      method: "GET",
      params: { orgId },
    }),

  /** 根据组织 ID 获取组织完整信息（含成员列表等扩展字段） */
  getFull: (orgId: string) =>
    request<OrgDetail>("/web/organizations/:orgId/full", {
      method: "GET",
      params: { orgId },
    }),

  /** 创建新组织 */
  create: (body: CreateOrgBody) => request<OrgInfo>("/web/organizations", { method: "POST", body }),

  /** 更新已有组织信息 */
  update: (orgId: string, body: UpdateOrgBody) =>
    request<OrgInfo>("/web/organizations/:orgId", {
      method: "PUT",
      params: { orgId },
      body,
    }),

  /** 删除指定组织 */
  del: (orgId: string) =>
    request<DeleteResult>("/web/organizations/:orgId", {
      method: "DELETE",
      params: { orgId },
    }),

  /** 将指定组织设为当前活跃组织 */
  setActive: (orgId: string) =>
    request<SetActiveResult>("/web/organizations/:orgId/active", {
      method: "POST",
      params: { orgId },
    }),

  /** 获取指定组织的成员列表 */
  listMembers: (orgId: string) =>
    request<OrgMember[]>("/web/organizations/:orgId/members", {
      method: "GET",
      params: { orgId },
    }),

  /** 向指定组织添加新成员 */
  addMember: (orgId: string, body: AddMemberBody) =>
    request<OrgMember>("/web/organizations/:orgId/members", {
      method: "POST",
      params: { orgId },
      body,
    }),

  /** 从指定组织中移除成员 */
  removeMember: (orgId: string, memberId: string) =>
    request<DeleteResult>("/web/organizations/:orgId/members/:memberId", {
      method: "DELETE",
      params: { orgId, memberId },
    }),

  /** 更新指定组织中某成员的角色 */
  updateRole: (orgId: string, memberId: string, role: string) =>
    request<OrgMember>("/web/organizations/:orgId/members/:memberId", {
      method: "PUT",
      params: { orgId, memberId },
      body: { role },
    }),
};
