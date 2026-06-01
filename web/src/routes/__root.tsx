import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { OrgProvider } from "../contexts/OrgContext";
import { useSession } from "../lib/auth-client";
import { ThemeProvider } from "../lib/theme";

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundPage,
});

function RootComponent() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t } = useTranslation("common");

  useEffect(() => {
    if (isPending) return;
    if (!session && pathname !== "/login") {
      void navigate({ to: "/login" });
    }
    if (session && pathname === "/login") {
      void navigate({ to: "/agent" });
    }
  }, [session, isPending, pathname, navigate]);

  if (isPending) {
    return (
      <ThemeProvider defaultTheme="system">
        <div className="flex h-screen flex-col items-center justify-center gap-4">
          <div className="h-10 w-10 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          <p className="text-sm text-text-muted">{t("connecting")}</p>
        </div>
      </ThemeProvider>
    );
  }

  if (!session && pathname !== "/login") {
    return null;
  }

  if (!session) {
    return (
      <ThemeProvider defaultTheme="system">
        <Outlet />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="system">
      <OrgProvider>
        <Outlet />
        <Toaster richColors closeButton position="top-right" />
      </OrgProvider>
    </ThemeProvider>
  );
}

function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold text-text-primary">404</h1>
      <p className="text-sm text-text-muted">{t("not_found")}</p>
      <button
        type="button"
        onClick={() => void navigate({ to: "/agent" })}
        className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90"
      >
        {t("back_home")}
      </button>
    </div>
  );
}
