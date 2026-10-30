import assert from "node:assert/strict";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
globals.IS_REACT_ACT_ENVIRONMENT = true;
for (const key of [
  "history",
  "location",
  "sessionStorage",
  "document",
  "navigator",
  "HTMLElement",
  "customElements",
  "Element",
  "Node",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "DocumentFragment",
  "NodeFilter",
]) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.window = win;
globals.scrollTo = win.scrollTo.bind(win);
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.matchMedia = win.matchMedia.bind(win);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createInstance } = await import("i18next");
const { I18nextProvider, initReactI18next } = await import("react-i18next");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import(
  "@tanstack/react-router"
);
const { OrgSessionProvider } = await import("@fenix/web-runtime/contexts/org-session");
const { MODELS_NS, modelManagementResources } = await import("../../i18n");
const { AgentModelsPage } = await import("../../pages/agent-panel/pages/AgentModelsPage");
const instance = createInstance();
await instance
  .use(initReactI18next)
  .init({ lng: "zh", ns: [MODELS_NS], resources: { zh: { [MODELS_NS]: modelManagementResources.zh } } });
const errors: string[] = [];
const originalError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ success: true, data: { providers: [] } })) as typeof fetch;
const rootRoute = createRootRoute();
const route = createRoute({ getParentRoute: () => rootRoute, path: "/", component: AgentModelsPage });
const router = createRouter({
  routeTree: rootRoute.addChildren([route]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
try {
  await router.load();
  await act(async () => {
    root.render(
      createElement(
        I18nextProvider,
        { i18n: instance },
        createElement(OrgSessionProvider, {
          value: { organizationId: "org-test", userId: "user-test", isOwner: true, pending: false },
          children: createElement(RouterProvider, { router }),
        }),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(container.textContent?.includes("新建服务商"), "模型页面应完成目录加载");
  assert.deepEqual(
    errors.filter((message) => message.includes("same key")),
    [],
    "两个独立弹窗不得共享 React key",
  );
} finally {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  console.error = originalError;
}
