import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const KnowledgeBasesPage = lazy(() =>
  import("../../pages/KnowledgeBasesPage").then((m) => ({ default: m.KnowledgeBasesPage })),
);

export const Route = createFileRoute("/_app/knowledge-bases")({
  component: () => (
    <Suspense>
      <KnowledgeBasesPage />
    </Suspense>
  ),
});
