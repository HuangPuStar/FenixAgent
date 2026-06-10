import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent/_panel/")({
  beforeLoad: () => {
    throw redirect({ to: "/agent/home" });
  },
});
