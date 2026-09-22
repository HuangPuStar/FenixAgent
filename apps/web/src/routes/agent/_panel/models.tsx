import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("@fenix/model-management/web").then((m) => ({ default: m.AgentModelsPage })));

export const Route = createFileRoute("/agent/_panel/models")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <Page />
    </Suspense>
  ),
});
