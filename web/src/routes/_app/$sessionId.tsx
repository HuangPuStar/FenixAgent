import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const SessionDetail = lazy(() => import("../../pages/SessionDetail").then((m) => ({ default: m.SessionDetail })));

export const Route = createFileRoute("/_app/$sessionId")({
  validateSearch: (search: Record<string, unknown>) => ({
    cwd: typeof search.cwd === "string" ? search.cwd : undefined,
    agentId: typeof search.agentId === "string" ? search.agentId : undefined,
  }),
  component: SessionRoute,
});

function SessionRoute() {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <Suspense>
      <SessionDetail key={sessionId} sessionId={sessionId} agentId={search.agentId} initialCwd={search.cwd} />
    </Suspense>
  );
}
