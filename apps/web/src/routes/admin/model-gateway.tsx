import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminModelGatewayPage = lazy(() =>
  import("@fenix/model-management/web").then((module) => ({ default: module.AdminModelGatewayPage })),
);

export const Route = createFileRoute("/admin/model-gateway")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense fallback={<Spinner variant="inline" label={t("states.loading")} className="p-6" />}>
        <AdminModelGatewayPage />
      </Suspense>
    );
  },
});
