// web/i18n/index.ts
// 本包自持命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 当前两份：`agents`（编辑器与站点页，271 键）与 `dashboard`（概览页，3 键）。
//
// 为什么这批键要迁入本包：它们原本寄居在宿主 `apps/web/src/i18n/locales/*/agents.json`，
// 但 271 个键的消费方几乎全是 agent-config 的编辑器与站点页面（当时宿主只剩未装配的
// `AgentManagementPage.tsx` 取 `management.*` / `categories.*`）。文案文件留在宿主，等于
// 「页面 owner」与「字典 owner」分属两侧，任一侧改名都不会被另一侧的门禁发现。迁入后本包
// 自持 `agents` 命名空间，宿主侧只删除旧文件并把注册改指本模块（见 README 的共享补丁清单）。
// 该页随后也随 §1.6 T11e 迁入本包，`agents` 命名空间的消费方自此全在本包内。
//
// 宿主注册方式（apps/web/src/i18n/index.ts）：从子路径 `@fenix/agent-config/web/i18n` 导入本模块，
// 把 `agentResources.en/zh` 登记到 `AGENTS_NS`。走子路径而不是 `./web` 根入口：宿主 i18n 在应用
// 启动期求值，从根入口导入会把整棵编辑器页面图（Radix 组件、站点 iframe、Monaco 等）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。

import agentHomeEn from "./locales/en/agentHome.json";
import en from "./locales/en/agents.json";
import dashboardEn from "./locales/en/dashboard.json";
import agentHomeZh from "./locales/zh/agentHome.json";
import zh from "./locales/zh/agents.json";
import dashboardZh from "./locales/zh/dashboard.json";

export { AGENT_HOME_NS, AGENTS_NS, DASHBOARD_NS } from "./namespace";

/**
 * agents 命名空间的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/agent-i18n.test.ts` 守护）。
 */
export const agentResources = { en, zh } as const;

export type AgentResources = typeof agentResources;

/**
 * dashboard 命名空间的 en / zh 文案资源；两份键结构完全一致（同一守卫断言）。
 */
export const dashboardResources = { en: dashboardEn, zh: dashboardZh } as const;

export type DashboardResources = typeof dashboardResources;

/**
 * agentHome 命名空间的 en / zh 文案资源；两份键结构完全一致（同一守卫断言）。
 */
export const agentHomeResources = { en: agentHomeEn, zh: agentHomeZh } as const;

export type AgentHomeResources = typeof agentHomeResources;
