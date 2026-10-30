// channel 向 WebShell 贡献的浏览器面能力（规格 §7.1）。
//
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」：分组与组间顺序由 Shell 持有，
// 资源模块不得反向决定全局布局（standards §4.1）。`id: "channels"` 同时是路由目标，
// Shell 会拼成 `/agent/channels`，与宿主路由壳文件名一一对应。
//
// 本文件是浏览器面：不得导入 `node:*`、`@server/*` 或本包的 `./server` / `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { MessageSquare } from "lucide-react";
import { CHANNELS_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    {
      id: "channels",
      groupId: "config",
      // config 组现有步长 10..100；65 落在 tasks(60) 与 memories(70) 之间，不与他包冲突。
      order: 65,
      ns: CHANNELS_NS,
      labelKey: "langbot.nav.channels",
      icon: MessageSquare,
    },
  ],
};
