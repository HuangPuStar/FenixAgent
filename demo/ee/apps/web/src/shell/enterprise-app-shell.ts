import type { WebShell } from "@fenix-ce/platform-sdk";

/**
 * EE 的完整应用壳，不继承或覆盖 CE 壳的局部实现。
 * 实际项目可独立实现企业首页、全局 Provider、SSO 初始化、导航与布局。
 */
export const enterpriseAppShell: WebShell = {
  id: "enterprise",
  homeRoute: "/",
  layoutDescription: "EE 企业工作台、企业导航与 SSO 后布局（demo）",
};
