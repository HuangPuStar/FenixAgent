import { createRootRoute, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import { App } from "./app";

const root = createRootRoute();
const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  validateSearch: (search: Record<string, unknown>): { tab: "pools" | "servers" | "sandboxes" } => ({
    tab: search.tab === "servers" || search.tab === "sandboxes" ? search.tab : "pools",
  }),
  component: App,
});

/** URL search owns the selected management tab across reloads and browser navigation. */
export function createConsoleRouter(history?: RouterHistory) {
  return createRouter({ routeTree: root.addChildren([index]), history, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createConsoleRouter>;
  }
}
