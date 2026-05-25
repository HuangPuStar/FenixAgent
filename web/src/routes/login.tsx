import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const LoginPage = lazy(() => import("../pages/LoginPage").then((m) => ({ default: m.LoginPage })));

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

function LoginRoute() {
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
