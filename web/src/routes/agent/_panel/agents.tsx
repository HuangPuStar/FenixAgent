import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";

const AgentManagementPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentManagementPage").then((m) => ({
    default: m.AgentManagementPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/agents")({
  component: AgentManagementPage,
});
