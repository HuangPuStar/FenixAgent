import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const WorkflowPage = lazy(() => import("../../pages/WorkflowPage").then((m) => ({ default: m.WorkflowPage })));

export const Route = createFileRoute("/_app/workflow")({
  component: () => (
    <Suspense>
      <WorkflowPage />
    </Suspense>
  ),
});
