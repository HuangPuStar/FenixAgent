import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("@fenix/resource-skill/web").then((m) => ({ default: m.AgentSkillsPage })));

export const Route = createFileRoute("/agent/_panel/skills")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <Page />
    </Suspense>
  ),
});
