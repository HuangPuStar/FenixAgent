// web/src/pages/admin/AdminSandboxPage.tsx
// 沙盒管理页入口（宿主路由直接渲染本组件）。自原 1529 行实现拆分后，本文件只剩鉴权门：
//   - 首次进入：sessionStorage 没有 master key 就停在共享的 AdminKeyGate；
//   - 面板内任意请求返回 UNAUTHORIZED（request 层把 401/403 归一为该码）：清 key、带错误回到门。
// 页面主体（Tab、列表、对话框）在 ./components/SandboxDashboard，状态编排在 ./use-sandbox-dashboard。
//
// 门组件与门的 state 都来自共享基建（`@fenix/ui-components/config/AdminKeyGate` +
// `@fenix/web-runtime/hooks/use-admin-key-gate`）：本包此前自持 `./components/MasterKeyGate`，
// 却被 observer 与 model-management 跨包复用（一道门拖来整个沙盒资源包），按归属下沉后本包不再对外出口它。

import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../i18n/namespace";
import { SandboxDashboard } from "./components/SandboxDashboard";

export function AdminSandboxPage() {
  const { t } = useTranslation(SANDBOX_NS);
  const gate = useAdminKeyGate(t("login.error"));

  return (
    <AdminKeyGate
      unlocked={gate.unlocked}
      error={gate.error}
      onUnlock={gate.unlock}
      title={t("login.title")}
      description={t("login.description")}
      inputPlaceholder={t("login.inputPlaceholder")}
      submitLabel={t("login.submit")}
    >
      <SandboxDashboard onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}
