// apps/web/src/__tests__/admin-nav-assembly.test.tsx
// 管理台工单入口的装配收窄守卫：**默认 profile（ce.json，无 tickets）下既没有导航项、也没有可用的路由**。
//
// 为什么需要这两条断言：`/admin/*` 不进根守卫 `AssemblyRouteGate` 的归属判定（没有任何贡献声明
// `routePrefixes: ["/admin/..."]`），因此管理台不像 `/agent/tickets` 那样被根守卫自动拦住——工单条目必须
// 自己在 `NAV_ITEMS` 里声明 `moduleId`、路由壳必须自己判一次能力。漏掉任一层时构建期都没有信号，症状是
// 默认产物里亮出一个点进去只显示「未启用」的入口，或直接挂载页面并发出请求。
//
// 渲染的是**真实组件**（`routes/admin.tsx` 与 `routes/admin/tickets.tsx` 的路由定义）而不是重写一份：
// 断言必须落在用户真正看到的侧栏与页面上。数据源与生产一致——`/web/system/modules` 的 `data.web`。
//
// 正向（ce-tickets 产物下入口可见、页面可挂载）不在本文件：构建期贡献产物由
// `bun run generate:web-contributions --profile deploy/assembly/ce-tickets.json` 决定，而工作区里的
// `apps/generated/web-contributions.ts` 必须匹配默认 `ce.json`（`web-contributions` 门禁守着它），因此
// 「装配清单含 tickets」这一态在本工作区里构造不出来。`enabledWebIds` / `routeWebId` 的纯函数语义已由
// `assembly-capabilities.test.tsx` 覆盖。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OBSERVER_NS, observerResources } from "@fenix/resource-observer/web/i18n";
import { TICKETS_NS, ticketsResources } from "@fenix/resource-tickets/web/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { clearCache } from "ahooks";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import zhCommon from "../i18n/locales/zh/common.json";
import { Route as AdminRoute } from "../routes/admin";
import { Route as AdminTicketsRoute } from "../routes/admin/tickets";
import { AssemblyCapabilitiesProvider } from "../shell/AssemblyCapabilitiesProvider";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/** 注入前记录的原始值；afterAll 逐条还原（本批测试与其它文件共享进程）。 */
const originalGlobals = new Map<string, unknown>(
  ["window", "document", "navigator", "HTMLElement", "customElements", "IS_REACT_ACT_ENVIRONMENT"].map(
    (key) => [key, globals[key]] as const,
  ),
);

Object.assign(globals, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  customElements: win.customElements,
  IS_REACT_ACT_ENVIRONMENT: true,
});

/**
 * 真实 i18next 实例：`common`（装配提示）＋ observer（布局与默认条目文案）＋ tickets（工单条目文案）。
 * 其它条目的字典缺席只会让它们回显键名，不影响本文件的断言（按 `href` 与提示文案判定）。
 */
const i18n = createInstance();
await i18n.init({
  lng: "zh",
  fallbackLng: "zh",
  defaultNS: "common",
  initAsync: false,
  resources: {
    zh: {
      common: zhCommon,
      [OBSERVER_NS]: observerResources.zh,
      [TICKETS_NS]: ticketsResources.zh,
    },
  },
});

/** 真实路由组件（路由文件不额外导出组件，取路由定义上的那一份，保证渲染的就是用户看到的那一份）。 */
const AdminLayout = AdminRoute.options.component as () => ReactNode;
const AdminTicketsShell = AdminTicketsRoute.options.component as () => ReactNode;

/** 默认产物（ce.json 生成的贡献清单）下运行期清单为空：与生产同一份判定输入。 */
const DEFAULT_WEB_MODULES: readonly string[] = [];

let requestedPaths: string[] = [];
let restoreFetch: () => void;
let container: HTMLElement;
let root: Root | undefined;

function stubModules(web: readonly string[]): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requestedPaths.push(url);
    if (!url.startsWith("/web/system/modules")) throw new Error(`未预期的请求：${url}`);
    return Response.json({ success: true, data: { modules: [], web } });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
}

/** 挂载一个只含被测页面的真实路由壳，并等待装配清单落地（ahooks 的 promise 链跨多个微任务）。 */
async function renderRoute(options: {
  readonly path: string;
  readonly component: () => ReactNode;
  readonly extraPaths?: readonly string[];
}): Promise<void> {
  const rootRoute = createRootRoute({ component: options.component });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: () => null }),
      createRoute({ getParentRoute: () => rootRoute, path: "/admin/tickets", component: () => null }),
      ...(options.extraPaths ?? []).map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ]),
    history: createMemoryHistory({ initialEntries: [options.path] }),
    isServer: true,
  });
  await router.load();
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AssemblyCapabilitiesProvider, null, createElement(RouterProvider, { router })),
      ),
    );
  });
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const navHrefs = (): string[] =>
  [...container.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href") ?? "");

const text = (): string => container.textContent ?? "";

beforeEach(() => {
  clearCache("system-assembly-modules");
  requestedPaths = [];
  stubModules(DEFAULT_WEB_MODULES);
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  container.remove();
  restoreFetch();
  clearCache("system-assembly-modules");
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

describe("管理台工单入口的装配收窄", () => {
  // 业务意图：默认产物里没有工单贡献，侧栏就不得出现工单入口——「入口可见但服务端 404」是缺陷。
  // 同时断言其余条目照常渲染：收窄是逐条目的，不能把整个导航一起藏掉。
  test("装配清单不含 tickets 时侧栏没有工单入口，其余条目照常", async () => {
    await renderRoute({ path: "/admin", component: AdminLayout });

    const hrefs = navHrefs();
    expect(hrefs).not.toContain("/admin/tickets");
    expect(hrefs).toContain("/admin/people");
    expect(hrefs).toContain("/admin/logs");
  });

  // 业务意图：手工输入 `/admin/tickets` 时显示与根守卫相同的「未启用」界面，**不挂载页面**（连懒加载子树
  // 都不进），因此不会向 `/api/system/tickets` 发任何请求。
  test("装配清单不含 tickets 时手工访问显示未启用且不发工单请求", async () => {
    await renderRoute({ path: "/admin/tickets", component: AdminTicketsShell });

    expect(text()).toContain(zhCommon.assembly.disabled.replace("{{module}}", "tickets"));
    expect(requestedPaths.filter((url) => url.startsWith("/api/system/tickets"))).toEqual([]);
    // 页面没挂载：门与列表的文案都不该出现。
    expect(text()).not.toContain(ticketsResources.zh.admin.gateTitle);
    expect(text()).not.toContain(ticketsResources.zh.admin.title);
  });
});
