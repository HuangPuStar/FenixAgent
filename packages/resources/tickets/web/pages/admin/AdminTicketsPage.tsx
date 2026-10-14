/**
 * 管理台工单页（宿主路由 `/admin/tickets` 直接渲染本组件）。
 *
 * 本文件承担两件事：鉴权门（与 observer / plugin-market 的管理页同形——sessionStorage 里没有 master key
 * 就停在共享的 `AdminKeyGate`；面板内请求返回 401 时清 key、带错误提示回门），以及在**同一路由内**切换
 * 「跨组织列表 ⇄ 单张工单详情」。
 *
 * **为什么详情不是子路由**：管理面是宿主 `/admin/tickets` 下的一块就地视图。走子路由要么把列表的筛选与页码
 * 搬进 URL（否则「从第 3 页点进详情再返回」会掉回第一页），要么在路由之间重新取一次列表；两者都不如
 * 「列表保持挂载、详情覆盖其上」直接。因此这里的切换是**同页两视图**：详情打开时列表 `hidden` 而不是卸载，
 * 返回时筛选、页码与已加载的行原样还在（也顺手避开了返回瞬间的空骨架）。
 *
 * **为什么跨组织的工单列表在管理台而不在控制台**：控制台那一面按组织过滤（`/web/tickets/:projectId`，跨组织与
 * 不存在同形 404），凭据是用户会话；看到全部组织的工单是平台运维视角，凭据是系统 master key。两者不是同一个
 * 页面的两个入口，而是两种凭据下的两种可见范围（详情视图同理，见 `./components/platform-ticket-detail`）。
 */

import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SystemTicketSummary } from "../../api/system-tickets";
import { TICKETS_NS } from "../../i18n/namespace";
import { PlatformTicketDetail } from "./components/platform-ticket-detail";
import { PlatformTicketList } from "./components/platform-ticket-list";

export function AdminTicketsPage() {
  const { t } = useTranslation(TICKETS_NS);
  const gate = useAdminKeyGate(t("admin.gateAuthFailed"));
  /** 选中的行（含归属坐标）；`null` 即停留在列表视图。 */
  const [selected, setSelected] = useState<SystemTicketSummary | null>(null);

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
      {/* `hidden` 而不是卸载：列表的取数、筛选与页码都是它自己的状态，卸载即丢失（见文件头）。 */}
      <div hidden={selected !== null}>
        <PlatformTicketList onAuthFailure={gate.fail} onOpen={setSelected} />
      </div>
      {selected === null ? null : (
        // 详情按工单号重挂载：换一张工单必须丢掉上一单的本地写状态（待确认 id、冲突、草稿），
        // 与路由参数变化时的重置同款；`key` 是这里唯一可靠的换代信号。
        <PlatformTicketDetail
          key={`${selected.projectId}:${selected.issueNumber}`}
          onAuthFailure={gate.fail}
          onBack={() => setSelected(null)}
          row={selected}
        />
      )}
    </AdminKeyGate>
  );
}
