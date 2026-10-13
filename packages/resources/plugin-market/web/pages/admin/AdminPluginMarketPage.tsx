// AdminPluginMarketPage.tsx — 管理台插件市场页入口（宿主路由 `/admin/plugin-market` 直接渲染本组件）
//
// 本文件只剩鉴权门（与 sandbox / model-management 两个管理页同形）：
//   - 首次进入：sessionStorage 里没有 master key 就停在共享的 `AdminKeyGate`；
//   - 面板内任意请求返回 401 / 403（`request()` 把两者归一为 `UNAUTHORIZED`）：清 key、带错误提示回门。
// 页面主体（列表、详情、写动作）在 `./components/plugin-market-admin-dashboard`。
//
// **为什么市场的管理在管理台而不在控制台**：发布、下架与恢复改变的是所有组织看到的内容，凭据是系统 master
// key——这与「用户看得见市场」是两件事。控制台那一面因此一个写入口都没有（`web/pages/agent-panel/**`）。

import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useTranslation } from "react-i18next";
import { PLUGIN_MARKET_NS } from "../../i18n/namespace";
import { PluginMarketAdminDashboard } from "./components/plugin-market-admin-dashboard";

export function AdminPluginMarketPage() {
  const { t } = useTranslation(PLUGIN_MARKET_NS);
  const gate = useAdminKeyGate(t("admin.gateAuthFailed"));

  return (
    <AdminKeyGate
      unlocked={gate.unlocked}
      error={gate.error}
      onUnlock={gate.unlock}
      title={t("admin.gateTitle")}
      description={t("admin.gateDescription")}
      inputPlaceholder={t("admin.gateInputPlaceholder")}
      submitLabel={t("admin.gateSubmit")}
    >
      <PluginMarketAdminDashboard onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}
