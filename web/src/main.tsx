import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./lib/card-renderer/builtins";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const router = createRouter({
  routeTree,
  basepath: "/ctrl",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
