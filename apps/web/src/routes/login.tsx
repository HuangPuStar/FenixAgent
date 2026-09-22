import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

const LoginPage = lazy(() => import("@/src/pages/LoginPage").then((m) => ({ default: m.LoginPage })));

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

function LoginRoute() {
  const { t } = useTranslation(NS.COMMON);
  // 登录页不在控制台壳内（`__root.tsx` 的未登录分支只挂 ThemeProvider），加载登录页 chunk 时整屏是它：
  // 按 §2.5 的全屏路由壳取 `screen`。此前是无 fallback 的 `<Suspense>`——等待期间整屏空白且读屏无提示。
  return (
    <Suspense fallback={<Spinner variant="screen" label={<span className="sr-only">{t("loading")}</span>} />}>
      <LoginPage />
    </Suspense>
  );
}
