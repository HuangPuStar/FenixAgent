/**
 * AgentConfig 领域服务的汇总出口。
 *
 * 只保留**不依赖进程装配**的纯领域能力与系统托管入口：
 * - 纯校验与规范化（`./agent-config`）——协议层在调用 Facade 前使用；
 * - Agent ↔ SiteApp 绑定（`./agent-config-site-app`）——绑定表归本包所有；
 * - 系统读取入口（`../system-entries`）——站点绑定校验用它做"这个 Agent 属于本组织吗"的判定，
 *   实例启动前的取数用它按真实用户身份读可见配置行。
 *
 * 其余能力（Skill / MCP / 知识库 / 记忆绑定）经 `AgentConfigServerModule.associations` 取得：
 * 它们由各自的资源包拥有，经模块门面读取才能让测试整体替换，也不需要在路由里裸导入资源包。
 */

export {
  type AgentConfigVisibleToUserInput,
  getAgentConfigById,
  getAgentConfigVisibleToUser,
  getReadableAgentConfigById,
} from "../../system-entries";
export * from "./agent-config";
export * from "./agent-config-site-app";
