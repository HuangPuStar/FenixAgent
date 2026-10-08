// 宿主 i18n 引导：只做「资源登记 + 语言探测」，不持有任何包的字典副本。
//
// 两类命名空间：
// - **包自有**：经子路径 `@fenix/<pkg>/web/i18n` 登记，键的最终所在地 = 包的 owner（计划 §4）。用子路径
//   而不是包根入口——本模块在应用启动时就求值，从根入口导入会把整个控制台页面图（页面、Radix 组件、
//   api client）拉进首屏 bundle。命名空间字面量取自 `@fenix/web-runtime/i18n/namespace` 的中心表和各包
//   导出的常量，宿主不复制字面量（两份字面量一旦分歧，症状是文案整片回退成 key 回显且构建期不可见）。
// - **宿主自有**：通用壳层（common / sidebar / …）与尚未迁出宿主的旧命名空间，仍读 `./locales/**`。
//   `login` 原在此列，随登录簇（页面 + 本地组件 + 传输适配 + 偏好 + 样式表）迁入 `@fenix/identity`
//   转为包自有：键的消费方只剩该包，字典按同一口径改由 `@fenix/identity/web/i18n` 登记。
//
// T9c 收敛：`TASKS` / `SESSIONS` / `ENVIRONMENTS` / `TOOL_NARRATOR` 四个宿主命名空间在全仓没有任何
// `useTranslation` 绑定（历史迁出后留下的空壳字典），连同其 JSON 一并删除，此处不再登记。中心表
// `@fenix/web-runtime/i18n/namespace` 仍保留这四个名称常量——它是跨包共享的**名称注册表**，删常量
// 无功能收益却要改跨包契约。
// T11e 起 `dashboard` 与 `agentHome` 也从宿主自有转出：两者的消费方（概览页、「创建智能体」首页与它的
// 生成表单）随「宿主剩余页面归位」迁入 `@fenix/agent-config`，字典按「键的最终所在地 = 包的 owner」
// 改由该包的 `./web/i18n` 登记。
// 2026-09-24（台账 D2）machine 成为有自持键的包：文件域实现整体迁入该包，它的文案按同一
// 「键的最终所在地 = 包的 owner」口径从宿主字典迁出，改由 `@fenix/resource-machine/web/i18n` 登记。
// 首批是上传 hook 的三条（`filePicker.fileTooLarge`、`fileTree.uploadFailed`、
// `fileTree.uploadPartialIndeterminate`）；同批的文件树容器与 tab 栏再迁入 21 条
// （`fileTree` 的重命名 / 移动 / 新建 / 下载 / 关闭标签 / 更多标签 / 输入弹窗与右键删除，
// 以及 `changedFiles.title`）。判据是「该键的消费方是否只剩迁入方」：留在宿主
// `components.fileTree` 的 `emptyState` / `emptyHint` / `userEmptyState` / `retry` / `staleBanner`
// 是同名键在 `uiComponents` 命名空间已另有一份（消费方是 `@fenix/ui-components` 的文件树视图），
// `dropToUpload` / `uploadTo` 的消费方是宿主面板自己的拖拽遮罩——它们不随迁，否则会在包字典里变成
// 死键（`packages/resources/machine/web/__tests__/machine-i18n.test.ts` 双向断言）。
// 2026-09-24（台账 D4）`agentPanel` / `components` 两份宿主持有字典完成余量拆分（此前记的「被多个包
// 共用，整体搬迁需跨包裁定」已按逐键口径结清）：
// - 只被宿主壳消费的键留在宿主（本模块的 `hostResources`），这是宿主自有命名空间的正当内容；
// - 被任一资源包消费的键搬进该包 `web/i18n`——站点与重启词条（`siteDeployment.*` / `panelMode.*` 的
//   站点部分 / `siteFrame.*`）归 `@fenix/resource-agent-config`，键名原样搬运；
// - 真正跨资源包共用的词条归共享包字典：`resource.*`（角标与公开/私有动作，四个资源包产出）与
//   `chat.components.permissionPanel.*`（权限确认按钮）进 `@fenix/ui-components` 的 `uiComponents`；
//   与组件库同名默认文案重复的 `confirmDialog.cancel` / `statusBadge.all` 不再复制，消费方直指该包。
// 宿主装配点改绑 `NS.AGENTS` / `NS.UI_COMPONENTS`（中心表已收录这两个名称），本模块无需新增登记。
// 2026-09-25（台账 D1）chat 域成为自持键的包：聊天容器簇从 `apps/web/src/pages/agent-panel/` 迁入
// `@fenix/agent-runtime/web`，键按同一「键的最终所在地 = 包的 owner」口径随实现迁出——`agentPanel` 的
// 11 条（欢迎态、登录态、连接中、断开与重连、发送失败）与宿主 `components` 的 `filePicker.title`，
// 全仓只被迁走的那几个文件消费（逐键 grep 确认），故从宿主字典删除而非复制。判据仍是「该键的消费方
// 是否只剩迁入方」：留在宿主 `agentPanel` 的 `showArtifacts` / `resizeArtifacts` 等由宿主壳
// （`ChatArea.tsx` 与 `chat-workspace-artifacts.tsx`）消费，不随迁。`agentChat` 尚未进中心表，
// 与 `SANDBOX` 同形：从包出口取常量，命名空间归属与字典同源。
import {
  AGENT_HOME_NS,
  AGENTS_NS,
  agentHomeResources,
  agentResources,
  DASHBOARD_NS,
  dashboardResources,
} from "@fenix/agent-config/web/i18n";
import { AGENT_CHAT_NS, agentChatResources } from "@fenix/agent-runtime/web/i18n";
import {
  APIKEY_NS,
  apikeyResources,
  LOGIN_NS,
  loginResources,
  ORGS_NS,
  orgResources,
  SETTINGS_NS,
  settingsResources,
} from "@fenix/identity/web/i18n";
import { MODELS_NS, modelManagementResources } from "@fenix/model-management/web/i18n";
import { CHANNELS_NS, channelsResources } from "@fenix/resource-channel/web/i18n";
import { KNOWLEDGE_NS, knowledgeResources } from "@fenix/resource-knowledge/web/i18n";
import { MACHINE_NS, machineResources } from "@fenix/resource-machine/web/i18n";
import { MCP_NS, mcpResources } from "@fenix/resource-mcp/web/i18n";
import { HINDSIGHT_NS, hindsightResources } from "@fenix/resource-memory/web/i18n";
import { OBSERVER_NS, observerResources } from "@fenix/resource-observer/web/i18n";
import { PLUGIN_MARKET_NS, pluginMarketResources } from "@fenix/resource-plugin-market/web/i18n";
import { PROD_VIEWS_NS, prodViewsResources } from "@fenix/resource-prod-view/web/i18n";
import { SANDBOX_NS, sandboxResources } from "@fenix/resource-sandbox/web/i18n";
import { SKILL_NS, skillResources } from "@fenix/resource-skill/web/i18n";
import { TASKS_V2_NS, tasksV2Resources } from "@fenix/resource-task/web/i18n";
import { WORKFLOW_NS, workflowResources } from "@fenix/resource-workflow-v2/web/i18n";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { NS as SHARED_NS } from "@fenix/web-runtime/i18n/namespace";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next/initReactI18next";
import agentPanelEN from "./locales/en/agentPanel.json";
import commonEN from "./locales/en/common.json";
import componentsEN from "./locales/en/components.json";
import sidebarEN from "./locales/en/sidebar.json";
import agentPanelZH from "./locales/zh/agentPanel.json";
import commonZH from "./locales/zh/common.json";
import componentsZH from "./locales/zh/components.json";
import sidebarZH from "./locales/zh/sidebar.json";

/**
 * 宿主命名空间表 = 跨包中心表（`@fenix/web-runtime/i18n/namespace`）+ 各包自有常量。
 *
 * 中心表已收录全部宿主自有命名空间与包自有命名空间；`SANDBOX` 与 `AGENT_CHAT` 尚未进表，先取包的常量，
 * 待中心表补齐后可直接改用 `SHARED_NS.*`。
 *
 * `UI_COMPONENTS` 的字典在 T5c2（`ChatPanel` 改指 ui-components 面板）随切换接入：包内聊天界面
 * 全量使用该命名空间，未登记时 i18next 会回显原始 key（整片文案变成 `chat.…`）。该包的字典经
 * `@fenix/ui-components/i18n` 登记（该包 exports 用 `./i18n` 而非 `./web/i18n`，命名空间常量另从
 * `@fenix/ui-components/i18n/namespace` 取，避免与字典同模块被一起拉进首屏）。
 */
export const NS = {
  ...SHARED_NS,
  SANDBOX: SANDBOX_NS,
  PLUGIN_MARKET: PLUGIN_MARKET_NS,
  AGENT_CHAT: AGENT_CHAT_NS,
} as const;

export type Namespace = (typeof NS)[keyof typeof NS];

/** 宿主自有命名空间的资源。 */
const hostResources = {
  en: {
    [NS.COMMON]: commonEN,
    [NS.SIDEBAR]: sidebarEN,
    [NS.COMPONENTS]: componentsEN,
    [NS.AGENT_PANEL]: agentPanelEN,
  },
  zh: {
    [NS.COMMON]: commonZH,
    [NS.SIDEBAR]: sidebarZH,
    [NS.COMPONENTS]: componentsZH,
    [NS.AGENT_PANEL]: agentPanelZH,
  },
} as const;

/**
 * 资源包自有命名空间的资源。键名用各包导出的常量（值等于中心表里的同一字面量）：这样「这个命名空间
 * 归谁所有」在导入点显式可见，漂移由包内 `web/__tests__/<pkg>-i18n.test.ts` 与中心表的一致性断言守护。
 */
const packageResources = {
  en: {
    [AGENTS_NS]: agentResources.en,
    [AGENT_CHAT_NS]: agentChatResources.en,
    [DASHBOARD_NS]: dashboardResources.en,
    [AGENT_HOME_NS]: agentHomeResources.en,
    [APIKEY_NS]: apikeyResources.en,
    [LOGIN_NS]: loginResources.en,
    [ORGS_NS]: orgResources.en,
    [MODELS_NS]: modelManagementResources.en,
    [OBSERVER_NS]: observerResources.en,
    [SKILL_NS]: skillResources.en,
    [MCP_NS]: mcpResources.en,
    [TASKS_V2_NS]: tasksV2Resources.en,
    [WORKFLOW_NS]: workflowResources.en,
    [CHANNELS_NS]: channelsResources.en,
    [KNOWLEDGE_NS]: knowledgeResources.en,
    [MACHINE_NS]: machineResources.en,
    [HINDSIGHT_NS]: hindsightResources.en,
    [PROD_VIEWS_NS]: prodViewsResources.en,
    [PLUGIN_MARKET_NS]: pluginMarketResources.en,
    [SANDBOX_NS]: sandboxResources.en,
    [SETTINGS_NS]: settingsResources.en,
    [UI_COMPONENTS_NS]: uiComponentsResources.en,
  },
  zh: {
    [AGENTS_NS]: agentResources.zh,
    [AGENT_CHAT_NS]: agentChatResources.zh,
    [DASHBOARD_NS]: dashboardResources.zh,
    [AGENT_HOME_NS]: agentHomeResources.zh,
    [APIKEY_NS]: apikeyResources.zh,
    [LOGIN_NS]: loginResources.zh,
    [ORGS_NS]: orgResources.zh,
    [MODELS_NS]: modelManagementResources.zh,
    [OBSERVER_NS]: observerResources.zh,
    [SKILL_NS]: skillResources.zh,
    [MCP_NS]: mcpResources.zh,
    [TASKS_V2_NS]: tasksV2Resources.zh,
    [WORKFLOW_NS]: workflowResources.zh,
    [CHANNELS_NS]: channelsResources.zh,
    [KNOWLEDGE_NS]: knowledgeResources.zh,
    [MACHINE_NS]: machineResources.zh,
    [HINDSIGHT_NS]: hindsightResources.zh,
    [PROD_VIEWS_NS]: prodViewsResources.zh,
    [PLUGIN_MARKET_NS]: pluginMarketResources.zh,
    [SANDBOX_NS]: sandboxResources.zh,
    [SETTINGS_NS]: settingsResources.zh,
    [UI_COMPONENTS_NS]: uiComponentsResources.zh,
  },
} as const;

const resources = {
  en: { ...hostResources.en, ...packageResources.en },
  zh: { ...hostResources.zh, ...packageResources.zh },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    defaultNS: NS.COMMON,
    // 从已登记的语言包取命名空间列表：新增命名空间只需改上面的两张表，不会再出现「注册了字典但漏进
    // `ns` 列表」的静默回退（en/zh 的键集合由各包 i18n 测试断言完全一致）。
    ns: Object.keys(resources.en),
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "rcs-lang",
      caches: ["localStorage"],
    },
  });

export default i18n;
