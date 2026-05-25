import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentsPage = lazy(() => import("../../pages/AgentsPage").then((m) => ({ default: m.AgentsPage })));

export const Route = createFileRoute("/_app/agents")({
  component: () => (
    <Suspense>
      <AgentsPage />
    </Suspense>
  ),
});
