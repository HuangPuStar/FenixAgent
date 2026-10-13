// web/contribution.ts
// memory 向 WebShell 贡献的浏览器面能力（§1.6 T11b）。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`（契约）与 review §7.25（三条用户裁定）。
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身——全局布局属应用壳，
//   资源模块不得反向决定（standards §4.1）。
// - **组内 `order` 沿用迁移前 `SIDEBAR_NAV_GROUPS` 的数组顺序**，用 10 的步长编码：
//   config 组内 memories 排第 7，故为 70。同组内其它包的项落在各自的步长上，留出的空档让
//   后续插入不必重排。迁移前后侧栏顺序逐项一致。
// - **文案 owner 是本包 `hindsight` 命名空间的 `nav.memories`**。宿主 `agentPanel` 字典里的
//   `memories` 键在 Shell 改由 registry 渲染的那一片（T11d）删除：两个字典都持有同一批文案
//   会让宿主删键时静默打断侧栏（§7.26）。
// - **图标随项贡献**：`Brain` 与迁移前逐字相同，侧栏外观零变化。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Brain } from "lucide-react";
import { HINDSIGHT_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    { id: "memories", groupId: "config", order: 70, ns: HINDSIGHT_NS, labelKey: "nav.memories", icon: Brain },
  ],
};
