import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminModelGatewayPage = lazy(() =>
  import("../../pages/admin/AdminModelGatewayPage").then((module) => ({ default: module.AdminModelGatewayPage })),
);

export const Route = createFileRoute("/admin/model-gateway")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense fallback={<div className="p-6 text-sm text-text-muted">{t("states.loading")}</div>}>
        <AdminModelGatewayPage />
      </Suspense>
    );
  },
});
