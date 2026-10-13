import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() => import("@fenix/model-management/web").then((m) => ({ default: m.ModelGatewayUsagePage })));

export const Route = createFileRoute("/agent/_panel/model-gateway-usage/$providerId")({
  component: () => {
    const { providerId } = Route.useParams();
    return (
      <Suspense fallback={<PanelRouteFallback />}>
        <Page providerId={providerId} />
      </Suspense>
    );
  },
});
