import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentDashboardPage").then((m) => ({ default: m.AgentDashboardPage })),
);

export const Route = createFileRoute("/agent/_panel/dashboard")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <Page />
    </Suspense>
  ),
});
