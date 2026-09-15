import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

function IndexRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/agent" });
  }, [navigate]);
  return null;
}

export const Route = createFileRoute("/")({
  component: IndexRedirect,
});
