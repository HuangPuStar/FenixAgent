import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminChannelsPage = lazy(() =>
  import("@fenix/resource-channel/web").then((m) => ({ default: m.AdminChannelsPage })),
);

export const Route = createFileRoute("/admin/channels")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense fallback={<Spinner variant="screen" label={t("states.loading")} />}>
        <AdminChannelsPage />
      </Suspense>
    );
  },
});
