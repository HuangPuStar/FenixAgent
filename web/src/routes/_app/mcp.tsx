import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const McpPage = lazy(() => import("../../pages/McpPage").then((m) => ({ default: m.McpPage })));

export const Route = createFileRoute("/_app/mcp")({
  component: () => (
    <Suspense>
      <McpPage />
    </Suspense>
  ),
});
