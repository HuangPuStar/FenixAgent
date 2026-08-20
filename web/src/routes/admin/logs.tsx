import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminLogsPage = lazy(() => import("../../pages/admin/AdminLogsPage").then((m) => ({ default: m.AdminLogsPage })));

export const Route = createFileRoute("/admin/logs")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center text-sm text-text-muted">{t("states.loading")}</div>
        }
      >
        <AdminLogsPage />
      </Suspense>
    );
  },
});
