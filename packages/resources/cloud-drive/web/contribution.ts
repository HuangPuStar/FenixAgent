// web/contribution.ts
// cloud-drive 向 WebShell 贡献的浏览器面能力。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`。本文件只声明「我是谁、属于哪个分组、组内排第几、
// 文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**（资源模块不得反向决定全局布局，standards §4.1）；
//   `core` 是「日常入口」组，云盘与首页 / 智能体 / 工作流 / 垂直模型同列。
// - **`order: 50`**：core 组现有 10/20/30/40 四档，50 接在 vertical-models 之后；步长 10 留出后续插入空间。
// - **文案 owner 是本包 `cloudDrive` 命名空间的 `nav.cloudDrive`**，字典在 `web/i18n/locales/**`。
// - **`id: "cloud-drive"`** 同时是路由目标（Shell 拼成 `/agent/cloud-drive`），宿主必须有同名路由壳
//   `apps/web/src/routes/agent/_panel/cloud-drive.tsx`（`shell-navigation-routes.test.ts` 守）。
//
// 本文件是浏览器面：不得导入 `node:*`、`@server/*` 或本包的 `./server` / `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Cloud } from "lucide-react";
import { CLOUD_DRIVE_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    {
      id: "cloud-drive",
      groupId: "core",
      order: 50,
      ns: CLOUD_DRIVE_NS,
      labelKey: "nav.cloudDrive",
      icon: Cloud,
    },
  ],
};
