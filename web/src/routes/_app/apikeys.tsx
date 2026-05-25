import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const ApiKeyManager = lazy(() => import("../../pages/ApiKeyManager").then((m) => ({ default: m.ApiKeyManager })));

export const Route = createFileRoute("/_app/apikeys")({
  component: ApiKeysRoute,
});

function ApiKeysRoute() {
  return (
    <Suspense>
      <ApiKeyManager />
    </Suspense>
  );
}
