// web/contribution.ts
// workflow-v2 向 WebShell 贡献的浏览器面能力（契约见 `@fenix/web-runtime/shell/contribution`）。
//
// 形状与旧包 `@fenix/resource-workflow/web/contribution` 逐项一致，这是**刻意的**：导航项 `id` 即路由
// 目标（Shell 拼成 `/agent/workflow`），`order` 决定它在 core 组内的位置，文案 key 落在同一命名空间——
// 2F 批次换包时侧栏外观与路由零变化。
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身：全局布局属应用壳（standards §4.1）；
// - **组内 `order` 沿用旧包取值（30）**，两个包不得同时启用，否则 core 组内会出现两个同 id、同 order 的项
//   （`generate:web-contributions` 会以「Web 模块 ID 重复」在构建期直接拒绝，见 fenix.module.ts 的 web 块）；
// - **文案 owner 是本包 `workflows` 命名空间的 `nav.workflow`**，取值与旧包逐字相同。
//
// 本文件是浏览器面：不得导入 `node:*`、`@server/*` 或本包的 `./server` / `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Workflow } from "lucide-react";
import { WORKFLOW_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    { id: "workflow", groupId: "core", order: 30, ns: WORKFLOW_NS, labelKey: "nav.workflow", icon: Workflow },
  ],
};
