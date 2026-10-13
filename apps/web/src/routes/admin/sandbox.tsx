import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminSandboxPage = lazy(() =>
  import("@fenix/resource-sandbox/web").then((m) => ({ default: m.AdminSandboxPage })),
);

export const Route = createFileRoute("/admin/sandbox")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense fallback={<Spinner variant="screen" label={t("states.loading")} />}>
        <AdminSandboxPage />
      </Suspense>
    );
  },
});
