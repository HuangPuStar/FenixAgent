import { OrgProvider, useSession } from "@fenix/identity/web";
import { ThemeProvider } from "@fenix/ui-components/lib/theme";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { ErrorPage } from "@/src/components/error-page";

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundPage,
});

function RootComponent() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t } = useTranslation("common");
  // /admin 观察面板独立于 better-auth 会话体系：无 session 也可访问，
  // 由页面内 MasterKeyGate 把关（docs/arch/21 §5），不触发登录跳转。
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
      <ThemeProvider defaultTheme="light">
        <Spinner variant="screen" size="lg" label={t("connecting")} className="gap-4" />
      </ThemeProvider>
    );
  }

  if (!session && pathname !== "/login" && !isAdminPath) {
    return null;
  }

  if (!session) {
    return (
      <ThemeProvider defaultTheme="light">
        <Outlet />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="light">
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
