// web/contribution.ts
// identity 向 WebShell 贡献的浏览器面能力（§1.6 T11b3）。
//
// 形状与判据见 `@fenix/web-runtime/shell/contribution`（契约）与 review §7.25（三条用户裁定）。
// 本文件只声明「我是谁、属于哪个分组、组内排第几、文案在哪」：
//
// - **分组（`groupId`）与组间顺序由 Shell 持有**，包不声明组本身——全局布局属应用壳，
//   资源模块不得反向决定（standards §4.1）。
// - **组内 `order` 沿用迁移前 `SIDEBAR_NAV_GROUPS` 的数组顺序**，用 10 的步长编码（10/20/…）：
//   config 组内 organizations 排第 9、apikeys 排第 10，故取 90 / 100；同组内其它包的项落在各自的
//   步长上，留出的空档让后续插入不必重排。迁移前后侧栏顺序逐项一致。
// - **文案 owner 是本包命名空间**（`nav.*` 两条），但**两项分属两个命名空间**：
//   `organizations` 落 `ORGS_NS`（迁移前以 `sidebar:organizations` 形式借用宿主 `sidebar` 字典，
//   本片起改为本包 `ORGS_NS` 自持），`apikeys` 落 `APIKEY_NS`（迁移前为 `agentPanel:apiKeys`）。
//   宿主 `agentPanel` / `sidebar` 字典里的同名键（`apiKeys` / `organizations`）在 Shell 改由 registry
//   渲染的那一片删除：两个字典都持有同一批文案会让宿主删键时静默打断侧栏（§7.26）。
//   逐项填各自的 `ns` 而非共用一条，是因为 Shell 的取值为 `t(labelKey, { ns })`，共用会让其中一项
//   回退成 key 回显。
// - **图标随项贡献**：`Users` / `KeyRound` 与迁移前逐字相同，侧栏外观零变化。

import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { KeyRound, Users } from "lucide-react";
import { APIKEY_NS, ORGS_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [
    { id: "organizations", groupId: "config", order: 90, ns: ORGS_NS, labelKey: "nav.organizations", icon: Users },
    { id: "apikeys", groupId: "config", order: 100, ns: APIKEY_NS, labelKey: "nav.apikeys", icon: KeyRound },
  ],
};
