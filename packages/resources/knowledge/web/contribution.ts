// web/contribution.ts
// knowledge 向 WebShell 贡献的浏览器面能力（§1.6 T11b）。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`（契约）与 review §7.25（三条用户裁定）。
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身——全局布局属应用壳，
//   资源模块不得反向决定（standards §4.1）。
// - **组内 `order` 沿用迁移前 `SIDEBAR_NAV_GROUPS` 的数组顺序**，用 10 的步长编码（10/20/…）：
//   `config` 组内 knowledge-bases 排第 4，故取 40；同组内其它包的项落在各自的步长上，留出的空档
//   让后续插入不必重排。迁移前后侧栏顺序逐项一致。
// - **文案 owner 是本包 `knowledge` 命名空间的 `nav.knowledgeBases`**，取值与迁移前宿主
//   `agentPanel` 字典的 `knowledgeBases` 键逐字相同。该键在 Shell 改由 registry 渲染的那一片
//   （T11d）删除：两个字典都持有同一批文案会让宿主删键时静默打断侧栏（§7.26）。
// - **图标随项贡献**：`BookOpen` 与迁移前逐字相同，侧栏外观零变化。
//
// 本文件是浏览器面：不得导入 `node:*`、`@server/*` 或本包的 `./server` / `./module` 出口。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { BookOpen } from "lucide-react";
import { KNOWLEDGE_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    {
      id: "knowledge-bases",
      groupId: "config",
      order: 40,
      ns: KNOWLEDGE_NS,
      labelKey: "nav.knowledgeBases",
      icon: BookOpen,
    },
  ],
};
