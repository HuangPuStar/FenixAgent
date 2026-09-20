// web/src/pages/admin/AdminSandboxPage.tsx
// 沙盒管理页入口（宿主路由直接渲染本组件）。自原 1529 行实现拆分后，本文件只剩鉴权门：
//   - 首次进入：sessionStorage 没有 master key 就停在 MasterKeyGate；
//   - 面板内任意请求返回 UNAUTHORIZED（request 层把 401/403 归一为该码）：清 key、带错误回到门。
// 页面主体（Tab、列表、对话框）在 ./components/SandboxDashboard，状态编排在 ./use-sandbox-dashboard。

import { clearAdminKey, getAdminKey } from "@fenix/web-runtime/lib/admin-key";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../i18n/namespace";
import { MasterKeyGate } from "./components/MasterKeyGate";
import { SandboxDashboard } from "./components/SandboxDashboard";

export function AdminSandboxPage() {
  const { t } = useTranslation(SANDBOX_NS);
  const [unlocked, setUnlocked] = useState(() => getAdminKey() !== null);
  const [gateError, setGateError] = useState<string | null>(null);
  const handleAuthFailure = useCallback(() => {
    clearAdminKey();
    setGateError(t("login.error"));
    setUnlocked(false);
  }, [t]);
  if (!unlocked) {
    return (
      <MasterKeyGate
        error={gateError}
        onUnlock={() => {
          setGateError(null);
          setUnlocked(true);
        }}
      />
    );
  }
  return <SandboxDashboard onAuthFailure={handleAuthFailure} />;
}
