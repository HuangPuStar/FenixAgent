import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() =>
  import("@fenix/resource-cloud-drive/web").then((m) => ({
    default: m.CloudDrivePage,
  })),
);

export const Route = createFileRoute("/agent/_panel/cloud-drive")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
