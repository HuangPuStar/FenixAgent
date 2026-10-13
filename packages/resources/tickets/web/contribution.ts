// web/contribution.ts
// tickets 向 WebShell 贡献的浏览器面能力。形状与判据见 `@fenix/web-runtime/shell/contribution`：
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」。
//
// - `id: "tickets"` 三用：路由目标（Shell 拼成 `/agent/tickets`）、运行时裁剪键（`hiddenTabs` 按它比对）、
//   装配能力键（路由壳与 `AssemblyRouteGate` 的能力判断都用它）。
// - **版位归 Shell**：声明在 `groupId: "footer"`（`apps/web/src/shell/shell-navigation.ts` 的
//   `FOOTER_NAV_GROUP_ID`）名下表示「这是底栏入口」——不进入侧栏分组，由 Shell 画在底部组织行左侧；
//   分组与版位同上属应用壳，资源模块不得反向决定（standards §4.1）。折叠态（侧栏 64px）该行整行不渲染，
//   入口因此随之隐藏，与组织切换同一口径。
// - **`order: 10`**：底栏版位内目前只有这一项；同版位内 order 必须唯一（`assembleNavigation` 重复即抛错）。
// - 文案 owner 是本包的 `tickets` 命名空间（`nav.tickets` 一条），宿主不持有同名键。
//
// 浏览器面约束：本包同时持有服务端实现，本文件只允许依赖纯浏览器模块（`lucide-react` 与
// `@fenix/web-runtime` 的类型出口），不得引入 `node:*`、`@server/*` 或本包 `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Ticket } from "lucide-react";
import { TICKETS_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [{ id: "tickets", groupId: "footer", order: 10, ns: TICKETS_NS, labelKey: "nav.tickets", icon: Ticket }],
};
