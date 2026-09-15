import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent/$agentId")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/agent/chat/$agentId", params: { agentId: params.agentId } });
  },
});
