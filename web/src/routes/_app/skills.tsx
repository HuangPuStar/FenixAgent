import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const SkillsPage = lazy(() => import("../../pages/SkillsPage").then((m) => ({ default: m.SkillsPage })));

export const Route = createFileRoute("/_app/skills")({
  component: () => (
    <Suspense>
      <SkillsPage />
    </Suspense>
  ),
});
