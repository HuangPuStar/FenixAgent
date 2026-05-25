import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const AppShellComponent = lazy(() => import("../components/shell/AppShell").then((m) => ({ default: m.AppShell })));

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const { t } = useTranslation("common");

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setCollapsed(e.matches);
    };
    handler(mq);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const firstSegment = pathname.replace(/^\//, "").split("/")[0];
  const isFullHeight = firstSegment === "workflow" || firstSegment === "";
  const configPages = [
    "models",
    "agents",
    "skills",
    "knowledge-bases",
    "mcp",
    "tasks",
    "channels",
    "workflow",
    "environments",
    "organizations",
    "apikeys",
    "login",
    "agent",
  ];
  const isSessionRoute = !configPages.includes(firstSegment) && firstSegment !== "";
  const mainClassName =
    isFullHeight || isSessionRoute ? "flex flex-1 flex-col overflow-hidden" : "flex-1 overflow-y-auto";

  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <AppShellComponent collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)}>
        <main className={mainClassName}>
          <Suspense
            fallback={
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
                <p className="text-sm text-text-muted">{t("loading")}</p>
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </AppShellComponent>
    </Suspense>
  );
}
