import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() =>
  import("@fenix/resource-knowledge/web").then((m) => ({
    default: m.AgentKnowledgeBasesPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/knowledge-bases")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <Page />
    </Suspense>
  ),
});
