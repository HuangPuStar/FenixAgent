import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const TasksPage = lazy(() => import("../../pages/TasksPage").then((m) => ({ default: m.TasksPage })));

export const Route = createFileRoute("/_app/tasks")({
  component: () => (
    <Suspense>
      <TasksPage />
    </Suspense>
  ),
});
