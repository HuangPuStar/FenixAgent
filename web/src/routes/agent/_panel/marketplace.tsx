import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";

const AgentMarketplacePage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentMarketplacePage").then((m) => ({
    default: m.AgentMarketplacePage,
  })),
);

export const Route = createFileRoute("/agent/_panel/marketplace")({
  component: AgentMarketplacePage,
});
