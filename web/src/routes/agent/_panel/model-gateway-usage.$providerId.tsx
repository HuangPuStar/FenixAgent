import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() =>
  import("../../../pages/agent-panel/pages/ModelGatewayUsagePage").then((m) => ({ default: m.ModelGatewayUsagePage })),
);

export const Route = createFileRoute("/agent/_panel/model-gateway-usage/$providerId")({
  component: () => {
    const { providerId } = Route.useParams();
    return (
      <Suspense fallback={<div className="flex flex-1 items-center justify-center" />}>
        <Page providerId={providerId} />
      </Suspense>
    );
  },
});
