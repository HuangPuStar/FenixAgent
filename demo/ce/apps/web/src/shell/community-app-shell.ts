import type { WebShell } from "@fenix-ce/platform-sdk";

/**
 * CE 的最终应用壳：实际项目在此提供 Provider、布局、首页、导航框架和路由出口。
 * 它是 CE 产品级组合，不属于资源模块，也不会被 EE 的资源页面间接修改。
 */
export const communityAppShell: WebShell = {
  id: "community",
  homeRoute: "/",
  layoutDescription: "CE 控制台布局、社区导航与首页工作台（demo）",
};
