import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";

const AgentManagementPage = lazy(() =>
  import("@fenix/agent-config/web").then((m) => ({
    default: m.AgentManagementPage,
  })),
);

export const Route = createFileRoute("/agent/_panel/agents")({
  component: AgentManagementPage,
});
