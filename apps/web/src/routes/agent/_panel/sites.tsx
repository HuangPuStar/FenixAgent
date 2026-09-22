import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("@fenix/agent-config/web").then((m) => ({ default: m.AgentSitesPage })));

export const Route = createFileRoute("/agent/_panel/sites")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <Page />
    </Suspense>
  ),
});
