import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

// 登录页归 `@fenix/identity`（凭据提交、加密、注册开关探测都在该包 `web/lib`），本文件是宿主唯一的
// 路由适配器。按窄子路径而非包根 `@fenix/identity/web` 取：根出口是身份控制台页（组织 / API Key 页
// 与 better-auth 客户端图）的桶，未登录用户的首屏不该驮着它们。
const LoginPage = lazy(() =>
  import("@fenix/identity/web/pages/login/LoginPage").then((m) => ({ default: m.LoginPage })),
);

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
