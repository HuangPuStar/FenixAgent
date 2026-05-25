import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/_app/")({
  component: () => <HomeRedirect />,
});

function HomeRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/agent" });
  }, [navigate]);
  return null;
}
