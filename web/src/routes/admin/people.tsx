import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminPeoplePage = lazy(() =>
  import("../../pages/admin/AdminPeoplePage").then((m) => ({ default: m.AdminPeoplePage })),
);

export const Route = createFileRoute("/admin/people")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center text-sm text-text-muted">{t("states.loading")}</div>
        }
      >
        <AdminPeoplePage />
      </Suspense>
    );
  },
});
