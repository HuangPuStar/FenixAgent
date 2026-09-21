// web/contribution.ts
// task 向 WebShell 贡献的浏览器面能力（§1.6 T11b5）。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`（契约）与 review §7.25（三条用户裁定）。
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身——全局布局属应用壳，
//   资源模块不得反向决定（standards §4.1）。
// - **组内 `order` 沿用迁移前 `SIDEBAR_NAV_GROUPS` 的数组顺序**，用 10 的步长编码（10/20/…）：
//   config 组内 tasks 排第 6，故取 60；同组内其它包的项落在各自的步长上，留出的空档让后续
//   插入不必重排。迁移前后侧栏顺序逐项一致。
// - **文案 owner 是本包的 `tasksV2` 命名空间**（`nav.tasks` 一条，常量 `TASKS_V2_NS` 取自共享
//   `NS` 表）。宿主 `agentPanel` 字典里的 `tasks` 键（迁移前以 `agentPanel:tasks` 形式被引用）
//   在 Shell 改由 registry 渲染的那一片删除：两个字典都持有同一批文案会让宿主删键时静默打断
//   侧栏（§7.26）。
// - **图标随项贡献**：`Clock` 与迁移前逐字相同，侧栏外观零变化。
//
// 浏览器面约束：本包同时持有服务端实现，本文件只允许依赖纯浏览器模块（`lucide-react` 与
// `@fenix/web-runtime` 的类型出口），不得引入 `node:*`、`@server/*` 或本包的 `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Clock } from "lucide-react";
import { TASKS_V2_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [{ id: "tasks", groupId: "config", order: 60, ns: TASKS_V2_NS, labelKey: "nav.tasks", icon: Clock }],
};
