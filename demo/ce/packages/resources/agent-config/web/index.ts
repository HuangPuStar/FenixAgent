/** 浏览器专用公开入口；不能导入 ../src 的 service、repository 或 db 实现。 */
export interface AgentConfigWebContribution {
  readonly route: "/agent-configs";
  readonly page: string;
}

/** demo 只证明资源模块可携带 web contribution，不实现 React 页面。 */
export const agentConfigWebContribution: AgentConfigWebContribution = {
  route: "/agent-configs",
  page: "空 AgentConfig 页面（demo）",
};
