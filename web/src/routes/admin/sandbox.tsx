import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminSandboxPage = lazy(() =>
  import("../../pages/admin/AdminSandboxPage").then((m) => ({ default: m.AdminSandboxPage })),
);

export const Route = createFileRoute("/admin/sandbox")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center text-sm text-text-muted">{t("states.loading")}</div>
        }
      >
        <AdminSandboxPage />
      </Suspense>
    );
  },
});
