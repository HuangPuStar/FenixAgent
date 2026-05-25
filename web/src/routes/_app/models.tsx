import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const ModelsPage = lazy(() => import("../../pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));

export const Route = createFileRoute("/_app/models")({
  component: () => (
    <Suspense>
      <ModelsPage />
    </Suspense>
  ),
});
