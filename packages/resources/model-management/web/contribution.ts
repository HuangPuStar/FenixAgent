// web/contribution.ts
// model-management 向 WebShell 贡献的浏览器面能力（§1.6 T11b2）。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`（契约）与 review §7.25（三条用户裁定）；
// 文件体例与同批的 `@fenix/agent-config/web/contribution.ts` 一致。
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身——全局布局属应用壳，
//   资源模块不得反向决定（standards §4.1）。
// - **组内 `order` 沿用迁移前 `SIDEBAR_NAV_GROUPS` 的数组顺序**，用 10 的步长编码（10/20/…）：
//   同组内其它包的项落在各自的步长上，留出的空档让后续插入不必重排。迁移前后侧栏顺序逐项一致——
//   `config` 组 `models`(10) / `algorithms`(20) 之后仍是 skills/knowledge-bases/mcp…，
//   `core` 组 `vertical-models`(40) 仍排在 home/agents/workflow 之后。
// - **文案 owner 是本包的 `models` 命名空间**（`nav.*` 三条，key 与迁移前宿主 `agentPanel` 字典
//   逐字对应）。宿主 `agentPanel` 字典里的同名键（`models` / `algorithms` / `verticalModels`）在
//   Shell 改由 registry 渲染的那一片删除：两个字典都持有同一批文案会让宿主删键时静默打断侧栏
//   （§7.25「导航文案归属」裁定的后果）。
// - **图标随项贡献**：`Cpu` / `Binary` / `Layers` 与迁移前逐字相同，侧栏外观零变化。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Binary, Cpu, Layers } from "lucide-react";
import { MODELS_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    { id: "models", groupId: "config", order: 10, ns: MODELS_NS, labelKey: "nav.models", icon: Cpu },
    { id: "algorithms", groupId: "config", order: 20, ns: MODELS_NS, labelKey: "nav.algorithms", icon: Binary },
    {
      id: "vertical-models",
      groupId: "core",
      order: 40,
      ns: MODELS_NS,
      labelKey: "nav.verticalModels",
      icon: Layers,
    },
  ],
};
