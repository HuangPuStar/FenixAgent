import { PLUGIN_MARKET_NS } from "@fenix/resource-plugin-market/web/i18n";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminPluginMarketPage = lazy(() =>
  import("@fenix/resource-plugin-market/web").then((m) => ({ default: m.AdminPluginMarketPage })),
);

export const Route = createFileRoute("/admin/plugin-market")({
  component: () => {
    const { t } = useTranslation(PLUGIN_MARKET_NS);
    return (
      <Suspense fallback={<Spinner variant="screen" label={t("loadState.loading")} />}>
        <AdminPluginMarketPage />
      </Suspense>
    );
  },
});
