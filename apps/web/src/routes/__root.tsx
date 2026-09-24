import { OrgProvider, useSession } from "@fenix/identity/web";
import { ThemeProvider } from "@fenix/ui-components/lib/theme";
import { ErrorFallback } from "@fenix/ui-components/ui/error-fallback";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { ErrorPage } from "@/src/components/error-page";

// 根布局边界（§7.1 放置矩阵第 1 行）：整个应用的兜底——`RootComponent` 四个分支（会话加载中 /
// 未登录直出 / 未登录壳 / 主壳）里任何没被下级边界接住的渲染异常都在这里收口，不再整页白屏。
// 位置在组件**外**：`RootComponent` 自身（`useSession` 等 hook）抛错时同样要被接住。
export const Route = createRootRoute({
  component: () => (
    <ErrorBoundary
      FallbackComponent={RootErrorFallback}
      onError={(error, info) => console.error("[Root] 渲染失败", error, info)}
    >
      <RootComponent />
    </ErrorBoundary>
  ),
  notFoundComponent: NotFoundPage,
});

/** 根布局降级 UI：整屏形态（崩溃时页面外壳已不可用，只剩这一屏）。文案取组件库字典，此处无需 i18n。 */
function RootErrorFallback({ resetErrorBoundary }: FallbackProps) {
  return <ErrorFallback resetErrorBoundary={resetErrorBoundary} variant="screen" />;
}

function RootComponent() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t } = useTranslation("common");
  // /admin 观察面板独立于 better-auth 会话体系：无 session 也可访问，
  // 由页面内 AdminKeyGate（共享组件库）把关（docs/arch/21 §5），不触发登录跳转。
  const isAdminPath = pathname.startsWith("/admin");

  useEffect(() => {
    if (isPending) return;
    if (!session && pathname !== "/login" && !isAdminPath) {
      void navigate({ to: "/login" });
    }
    if (session && pathname === "/login") {
      void navigate({ to: "/agent" });
    }
  }, [session, isPending, pathname, navigate, isAdminPath]);

  if (isPending) {
    return (
      <ThemeProvider>
        <Spinner variant="screen" size="lg" label={t("connecting")} className="gap-4" />
      </ThemeProvider>
    );
  }

  if (!session && pathname !== "/login" && !isAdminPath) {
    return null;
  }

  if (!session) {
    return (
      <ThemeProvider>
        <Outlet />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <OrgProvider>
        <Outlet />
        <Toaster richColors closeButton position="top-right" />
      </OrgProvider>
    </ThemeProvider>
  );
}

// 404 与 403 共用 `ErrorPage`（此前两份逐字复制的整屏错误页）。
function NotFoundPage() {
  const { t } = useTranslation("common");
  return <ErrorPage code="404" message={t("not_found")} backLabel={t("back_home")} />;
}
