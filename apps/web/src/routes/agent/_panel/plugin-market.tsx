import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() => import("@fenix/resource-plugin-market/web").then((m) => ({ default: m.PluginMarketPage })));

export const Route = createFileRoute("/agent/_panel/plugin-market")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
