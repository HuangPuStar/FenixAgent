import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("@fenix/resource-prod-view/web").then((m) => ({ default: m.AgentProdViewsPage })));

export const Route = createFileRoute("/agent/_panel/views")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <Page />
    </Suspense>
  ),
});
