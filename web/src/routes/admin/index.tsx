import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminObserverPage = lazy(() =>
  import("../../pages/admin/AdminObserverPage").then((m) => ({ default: m.AdminObserverPage })),
);

export const Route = createFileRoute("/admin/")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense
        fallback={
          <div className="flex h-screen flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
            <p className="text-sm text-text-muted">{t("states.loading")}</p>
          </div>
        }
      >
        <AdminObserverPage />
      </Suspense>
    );
  },
});
