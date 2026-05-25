import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const OrgsPage = lazy(() => import("../../pages/OrgsPage").then((m) => ({ default: m.OrgsPage })));

export const Route = createFileRoute("/_app/organizations")({
  component: () => (
    <Suspense>
      <OrgsPage />
    </Suspense>
  ),
});
