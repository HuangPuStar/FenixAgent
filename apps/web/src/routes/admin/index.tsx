import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AdminObserverPage = lazy(() =>
  import("@fenix/resource-observer/web").then((m) => ({ default: m.AdminObserverPage })),
);

export const Route = createFileRoute("/admin/")({
  component: () => {
    const { t } = useTranslation("observer");
    return (
      <Suspense fallback={<Spinner variant="screen" label={t("states.loading")} />}>
        <AdminObserverPage />
      </Suspense>
    );
  },
});
