// web/contribution.ts
// plugin-market 向 WebShell 贡献的浏览器面能力。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`（契约）。本文件只声明「我是谁、属于哪个分组、
// 组内排第几、文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身——全局布局属应用壳，资源模块不得反向
//   决定（standards §4.1）。
// - **组内 `order: 110`**：`config` 组现有 10 项占满 10..100 的整十步长（models 10 / algorithms 20 /
//   skills 30 / knowledge-bases 40 / mcp 50 / tasks 60 / memories 70 / sites 80 / organizations 90 /
//   apikeys 100），没有空档；`order` 是组内唯一排序键，重复即 Shell 装配期抛错。市场是**新增**能力而
//   不是迁移进来的旧页，因此落在组尾 110 而不重排既有项。
// - **文案 owner 是本包的 `pluginMarket` 命名空间**（`nav.pluginMarket` 一条），宿主不再维护中央字典。
// - **图标随项贡献**：`Package`。
//
// 浏览器面约束：本包同时持有服务端实现，本文件只允许依赖纯浏览器模块（`lucide-react` 与
// `@fenix/web-runtime` 的类型出口），不得引入 `node:*`、`@server/*` 或本包的 `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Package } from "lucide-react";
import { PLUGIN_MARKET_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    {
      id: "plugin-market",
      groupId: "config",
      order: 110,
      ns: PLUGIN_MARKET_NS,
      labelKey: "nav.pluginMarket",
      icon: Package,
    },
  ],
};
