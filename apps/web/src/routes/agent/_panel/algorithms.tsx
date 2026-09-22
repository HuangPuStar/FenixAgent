import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AlgorithmsPage = lazy(() =>
  import("@fenix/model-management/web").then((module) => ({
    default: module.AlgorithmsPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/algorithms")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <AlgorithmsPage />
    </Suspense>
  ),
});
