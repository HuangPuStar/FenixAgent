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
    // 与同目录其余三个 admin 路由壳同一形态：整屏等待（`screen` + 可见文案）
    return (
      <Suspense fallback={<Spinner variant="screen" label={t("states.loading")} />}>
        <AdminModelGatewayPage />
      </Suspense>
    );
  },
});
