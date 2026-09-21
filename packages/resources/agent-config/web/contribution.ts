// web/contribution.ts
// agent-config 向 WebShell 贡献的浏览器面能力（§1.6 T11b1）。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`（契约）与 review §7.25（三条用户裁定）。
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身——全局布局属应用壳，
//   资源模块不得反向决定（standards §4.1）。
// - **组内 `order` 沿用迁移前 `SIDEBAR_NAV_GROUPS` 的数组顺序**，用 10 的步长编码（10/20/…）：
//   同组内其它包的项落在各自的步长上，留出的空档让后续插入不必重排。迁移前后侧栏顺序逐项一致。
// - **文案 owner 是本包的 `agents` 命名空间**（`nav.*` 三条）。宿主 `agentPanel` / `sidebar`
//   字典里的同名键（`createAgent` / `agentManagement` / `sites`）在 Shell 改由 registry 渲染的
//   那一片删除：两个字典都持有同一批文案会让宿主删键时静默打断侧栏（§7.26）。
// - **图标随项贡献**：`Plus` / `Bot` / `Globe` 与迁移前逐字相同，侧栏外观零变化。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Bot, Globe, Plus } from "lucide-react";
import { AGENTS_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    { id: "home", groupId: "core", order: 10, ns: AGENTS_NS, labelKey: "nav.home", icon: Plus },
    { id: "agents", groupId: "core", order: 20, ns: AGENTS_NS, labelKey: "nav.agents", icon: Bot },
    { id: "sites", groupId: "config", order: 80, ns: AGENTS_NS, labelKey: "nav.sites", icon: Globe },
  ],
};
