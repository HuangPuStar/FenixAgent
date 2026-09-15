import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent/$agentId_/$sessionId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/agent/chat/$agentId/$sessionId",
      params: { agentId: params.agentId, sessionId: params.sessionId },
    });
  },
});
