import { request } from "./request";

/** 侧边栏公开配置 */
export interface SidebarConfig {
  hiddenTabs: string[];
}

export const sidebarConfigApi = {
  /** 获取前端侧边栏展示配置 */
  get: () => request<SidebarConfig>("/web/sidebar-config", { method: "GET" }),
};
