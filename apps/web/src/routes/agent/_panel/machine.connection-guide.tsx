import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";

const ConnectionGuide = lazy(() =>
  import("@fenix/resource-machine/web").then((machine) => ({ default: machine.MachineConnectionGuide })),
);

export const Route = createFileRoute("/agent/_panel/machine/connection-guide")({
  validateSearch: (search: Record<string, unknown>): { machineId: string; organizationId?: string } => ({
    machineId: typeof search.machineId === "string" ? search.machineId : "",
    organizationId: typeof search.organizationId === "string" ? search.organizationId : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (!search.machineId) throw redirect({ to: "/agent/organizations" });
  },
  component: ConnectionGuideRoute,
});

function ConnectionGuideRoute() {
  const { machineId, organizationId } = Route.useSearch();
  return (
    <Suspense fallback={<PanelRouteFallback />}>
      <ConnectionGuide
        key={JSON.stringify([machineId, organizationId])}
        machineId={machineId}
        organizationId={organizationId}
      />
    </Suspense>
  );
}
