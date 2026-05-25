import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const EnvironmentsPage = lazy(() =>
  import("../../pages/EnvironmentsPage").then((m) => ({ default: m.EnvironmentsPage })),
);

export const Route = createFileRoute("/_app/environments")({
  component: EnvironmentsRoute,
});

function EnvironmentsRoute() {
  return (
    <Suspense>
      <EnvironmentsPage />
    </Suspense>
  );
}
