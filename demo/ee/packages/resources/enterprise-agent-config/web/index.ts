import type { AgentConfigWebContribution } from "@fenix-ce/agent-config/web";

/** EE 用独立页面替换 CE 空页面；真实项目在此增加发布按钮和审批状态。 */
export const enterpriseAgentConfigWebContribution: AgentConfigWebContribution = {
  route: "/agent-configs",
  page: "空 EE AgentConfig 发布页面（demo）",
};
