// web/contribution.ts
// tickets 向 WebShell 贡献的浏览器面能力。形状与判据见 `@fenix/web-runtime/shell/contribution`：
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」。
//
// - `id: "tickets"` 三用：路由目标（Shell 拼成 `/agent/tickets`）、运行时裁剪键（`hiddenTabs` 按它比对）、
//   装配能力键（路由壳与 `AssemblyRouteGate` 的能力判断都用它）。
// - **分组（`groupId`）与组间顺序由 Shell 持有**（`apps/web/src/shell/shell-navigation.ts` 的
//   `SHELL_NAV_GROUPS`），包只声明归属与组内序号：全局布局属应用壳，资源模块不得反向决定。
// - **`order: 110`**：config 组内 10..100 的十格已被既有项占满（models 10 / algorithms 20 / skills 30 /
//   knowledge-bases 40 / mcp 50 / tasks 60 / memories 70 / sites 80 / organizations 90 / apikeys 100），
//   本包按 10 的步长接在组末，避免重排任何既有项。**不能取 70**（即便某份计划如此写）：`memories` 已占用
//   70，而 `assembleNavGroups` 对组内重复 `order` 直接抛错——含 tickets 的装配清单会在模块加载期停摆。
// - 文案 owner 是本包的 `tickets` 命名空间（`nav.tickets` 一条），宿主不持有同名键。
//
// 浏览器面约束：本包同时持有服务端实现，本文件只允许依赖纯浏览器模块（`lucide-react` 与
// `@fenix/web-runtime` 的类型出口），不得引入 `node:*`、`@server/*` 或本包 `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Ticket } from "lucide-react";
import { TICKETS_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [{ id: "tickets", groupId: "config", order: 110, ns: TICKETS_NS, labelKey: "nav.tickets", icon: Ticket }],
};
