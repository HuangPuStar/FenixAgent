import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AlgorithmsPage = lazy(() =>
  import("@fenix/model-management/web").then((module) => ({
    default: module.AlgorithmsPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/algorithms")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <AlgorithmsPage />
    </Suspense>
  ),
});
