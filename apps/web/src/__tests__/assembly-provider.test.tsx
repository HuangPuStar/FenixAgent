import { expect, spyOn, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { clearCache } from "ahooks";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import zh from "../i18n/locales/zh/common.json";
import { AssemblyCapabilitiesProvider, useAssemblyCapabilities } from "../shell/AssemblyCapabilitiesProvider";
import { AssemblyRouteGate, AssemblyRouteState } from "../shell/AssemblyRouteGate";

const window = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  customElements: window.customElements,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const i18n = createInstance();
await i18n.init({ lng: "zh", resources: { zh: { common: zh } }, defaultNS: "common", initAsync: false });

// 真实 TanStack 路由出口读取 URL；并非仅对手工传入的模块 ID 作展示断言。
test("内存路由直达 workflow 由共享 Gate 拦截，启用时挂载原页面", async () => {
  for (const web of [[], ["workflow"]]) {
    clearCache("system-assembly-modules");
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, data: { modules: web.length ? ["workflow-v2"] : [], web } }),
    );
    let mounted = false;
    const rootRoute = createRootRoute({
      component: () => (
        <AssemblyCapabilitiesProvider>
          <AssemblyRouteGate>
            <Outlet />
          </AssemblyRouteGate>
        </AssemblyCapabilitiesProvider>
      ),
    });
    const page = createRoute({
      getParentRoute: () => rootRoute,
      path: "/agent/workflow/$id/edit",
      component: () => {
        mounted = true;
        return <p>原画布页面</p>;
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ["/agent/workflow/123/edit"] }),
      isServer: true,
    });
    const host = window.document.createElement("div") as unknown as HTMLDivElement;
    const root = createRoot(host);
    try {
      await router.load();
      await act(async () => {
        root.render(
          <I18nextProvider i18n={i18n}>
            <RouterProvider router={router} />
          </I18nextProvider>,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(host.textContent).toContain(web.length ? "原画布页面" : "模块 workflow 未启用");
      expect(mounted).toBe(web.length > 0);
    } finally {
      act(() => root.unmount());
      fetchSpy.mockRestore();
      clearCache("system-assembly-modules");
    }
  }
});

function Consumer() {
  const state = useAssemblyCapabilities();
  return (
    <AssemblyRouteState moduleId="workflow" state={state}>
      <p>工作流页面已挂载</p>
    </AssemblyRouteState>
  );
}

// 多消费者共享启动请求，失败只记一次结构化信号，重试后应使用新清单阻止被禁页面。
test("清单请求去重、错误 fail-open 与点击重试恢复", async () => {
  clearCache("system-assembly-modules");
  const host = window.document.createElement("div") as unknown as HTMLDivElement;
  const root = createRoot(host);
  let complete: ((response: Response) => void) | undefined;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const logSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AssemblyCapabilitiesProvider>
            <Consumer />
            <Consumer />
          </AssemblyCapabilitiesProvider>
        </I18nextProvider>,
      );
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("正在读取模块启用状态");
    await act(async () => {
      complete?.(
        Response.json({ success: false, error: { code: "UNAVAILABLE", message: "暂不可用" } }, { status: 503 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.textContent).toContain("工作流页面已挂载");
    expect(host.textContent).toContain("模块清单读取失败");
    expect(
      logSpy.mock.calls.filter(
        ([value]) => typeof value === "object" && value?.event === "assembly_modules_fetch_failed",
      ),
    ).toHaveLength(1);
    await act(async () => {
      host.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await act(async () => {
      complete?.(Response.json({ success: true, data: { modules: [], web: [] } }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.textContent).toContain("模块 workflow 未启用");
    expect(host.textContent).not.toContain("工作流页面已挂载");
  } finally {
    act(() => root.unmount());
    fetchSpy.mockRestore();
    logSpy.mockRestore();
    clearCache("system-assembly-modules");
  }
});
