import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const Page = lazy(() => import("@fenix/resource-mcp/web").then((m) => ({ default: m.AgentMcpPage })));

export const Route = createFileRoute("/agent/_panel/mcp")({
  component: () => (
    <Suspense fallback={<PanelRouteFallback />}>
      <Page />
    </Suspense>
  ),
});
