/**
 * sites.ts — Agent Sites 域 API 模块
 *
 * 封装 Agent Sites（前端站点应用）的 CRUD、文件上传、Token 轮换、
 * 以及与 AgentConfig 的绑定/解绑操作，统一通过 request() 与后端通信。
 */

import { request } from "./request";

/** Agent Site 应用基本信息 */
export interface SiteApp {
  id: string;
  organizationId: string;
  userId: string;
  remoteAppId: string;
  name: string;
  description: string | null;
  visibility: "private" | "org" | "authenticated" | "public";
  /** Site 创建者 agent config id。null 表示创建者已删除，所有绑定 agent 均可操作。 */
  createdByAgentConfigId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 创建站点应用请求体 */
export interface SiteCreateBody {
  name: string;
  description?: string;
  visibility?: "private" | "org" | "authenticated" | "public";
}

/** 更新站点应用请求体（部分字段可选） */
export interface SiteUpdateBody {
  name?: string;
  description?: string;
  visibility?: "private" | "org" | "authenticated" | "public";
}

export const agentSitesApi = {
  /** 分页查询站点应用列表 */
  list: () => request<SiteApp[]>("/web/agent-sites/apps", { method: "GET" }),

  /** 根据站点 ID 获取单个站点应用详情 */
  get: (id: string) => request<SiteApp>("/web/agent-sites/apps/:id", { method: "GET", params: { id } }),

  /** 根据远程应用 ID 获取对应的站点应用 */
  getByRemote: (remoteAppId: string) =>
    request<SiteApp>("/web/agent-sites/apps/by-remote/:remoteAppId", {
      method: "GET",
      params: { remoteAppId },
    }),

  /** 创建新的站点应用 */
  create: (body: SiteCreateBody) => request<SiteApp>("/web/agent-sites/apps", { method: "POST", body }),

  /** 更新站点应用信息 */
  update: (id: string, body: SiteUpdateBody) =>
    request<SiteApp>("/web/agent-sites/apps/:id", { method: "PATCH", params: { id }, body }),

  /** 删除站点应用 */
  del: (id: string) => request<void>("/web/agent-sites/apps/:id", { method: "DELETE", params: { id } }),

  /** 删除站点应用（别名） */
  delete: (id: string) => request<void>("/web/agent-sites/apps/:id", { method: "DELETE", params: { id } }),

  /** 轮换站点应用的访问 Token，旧 Token 立即失效 */
  rotateToken: (id: string) =>
    request<void>("/web/agent-sites/apps/:id/rotate-token", {
      method: "POST",
      params: { id },
    }),

  /**
   * 上传站点内单个文件。
   * path 为站点内的相对文件路径（如 index.html、css/style.css），body 为文件内容。
   * 注意：path 不做 URL 编码，由调用方保证路径格式正确。
   */
  uploadFile: (id: string, path: string, body: BodyInit) =>
    request<void>(`/web/agent-sites/apps/${id}/files/${path}`, { method: "PUT", body }),

  /** 上传站点打包文件（bundle），通常为 zip 包，后端自动解压部署 */
  uploadBundle: (id: string, body: BodyInit) =>
    request<void>("/web/agent-sites/apps/:id/files/bundle", {
      method: "POST",
      params: { id },
      body,
    }),

  /**
   * 按 agentConfigId 拉取绑定的站点应用详情列表。
   * chat 右侧 ArtifactsPanel 用它来填充顶部 Files / Site1 / Site2 tab。
   * 返回顺序与绑定顺序一致（按 created_at 升序），UI 展示稳定。
   */
  listByAgentConfig: (agentConfigId: string) =>
    request<SiteApp[]>("/web/agent-sites/agent-configs/:agentConfigId/sites", {
      method: "GET",
      params: { agentConfigId },
    }),

  /**
   * 将站点应用绑定到 Agent 配置。
   * chat 右侧 Sites tab 的 + 按钮调用。
   * 后端走 PK 联合唯一 + ON CONFLICT DO NOTHING，重复绑定幂等。
   */
  bindSite: (agentConfigId: string, siteAppId: string) =>
    request<void>("/web/agent-sites/agent-configs/:agentConfigId/sites/:siteAppId", {
      method: "POST",
      params: { agentConfigId, siteAppId },
    }),

  /**
   * 将站点应用从 Agent 配置解绑。
   * chat 右侧 Sites tab 的 x 按钮调用。DELETE 天然幂等。
   */
  unbindSite: (agentConfigId: string, siteAppId: string) =>
    request<void>("/web/agent-sites/agent-configs/:agentConfigId/sites/:siteAppId", {
      method: "DELETE",
      params: { agentConfigId, siteAppId },
    }),
};
