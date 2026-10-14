/**
 * 管理台工单页（宿主路由 `/admin/tickets` 直接渲染本组件）。
 *
 * 本文件只剩鉴权门（与 observer / plugin-market 的管理页同形）：sessionStorage 里没有 master key 就停在共享的
 * `AdminKeyGate`；面板内请求返回 401（`request()` 把 401/403 归一为 `UNAUTHORIZED`）时清 key、带错误提示回门。
 * 列表主体在 `./components/platform-ticket-list`。
 *
 * **为什么跨组织的工单列表在管理台而不在控制台**：控制台那一面按组织过滤（`/web/tickets/:projectId`，跨组织与
 * 不存在同形 404），凭据是用户会话；看到全部组织的工单是平台运维视角，凭据是系统 master key。两者不是同一个
 * 页面的两个入口，而是两种凭据下的两种可见范围。
 */

import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useTranslation } from "react-i18next";
import { TICKETS_NS } from "../../i18n/namespace";
import { PlatformTicketList } from "./components/platform-ticket-list";

export function AdminTicketsPage() {
  const { t } = useTranslation(TICKETS_NS);
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
      <PlatformTicketList onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}
