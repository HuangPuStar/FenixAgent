// web/__tests__/agent-ticket-detail-states.test.tsx
// 工单详情页的关键交互用例：成功态上屏什么、三种失败态各自落到哪一支、外部来源标注是否出现。
//
// 为什么用真实渲染而不是读源码断言：被钉住的行为都取决于分支顺序与运行时的状态流转——
// 「加载成功时标题 / 正文 / 作者姓名真的出现在页面上」「NOT_FOUND 与 401/403 不给重试、其余失败给重试」
// 「点重试真的重新拉取并恢复」「`author.source === "external"` 必须明说归属待核对」——源码里出现
// `loadState.notFoundTitle` 或 `detail.externalAuthor` 字样，并不等于运行时走到了那一支。
//
// 环境：happy-dom + react-dom/client。**不用 `mock.module`**：react-i18next 用真实实例 + 本包真字典，
// `@tanstack/react-router` 用真实内存路由（页面顶部的返回链接与 201 跳转都走真路由器），sonner 真实调用
// 但无 Toaster 时静默丢弃。唯一的外部数据源是 `fetch`，用例直接替换 `globalThis.fetch`。
//
// 正文渲染经 `MessageResponse mode="static"`（前端规范 §6.1 的唯一 Markdown 链路），断言的是
// **正文文本上屏**这一行为；Markdown → HTML 的细节归 `packages/ui-components` 自己的用例。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { TICKETS_NS, ticketsResources } from "../i18n";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/**
 * Radix（EmptyState 里的按钮、页头）与 streamdown（正文）在 happy-dom 下需要的全局构造器，
 * 注入后必须在 afterAll 还原：`bun test packages/` 同进程跑完所有包，留下注入会污染后续文件；
 * `HTMLElement` 与 `customElements` 必须成对注入（口径见 `@fenix/ui-components/web/testing.ts`）。
 */
const DOM_GLOBALS = [
  "CustomEvent",
  "DOMRect",
  "DocumentFragment",
  "Element",
  "Event",
  "EventTarget",
  "FocusEvent",
  "HTMLElement",
  "HTMLAnchorElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "PointerEvent",
  "ResizeObserver",
  "SVGElement",
  "customElements",
] as const;

/** 注入前记录的原始值（含未定义），afterAll 逐条还原。 */
const originalGlobals = new Map<string, unknown>([
  ...["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, globals[key]] as const),
  ...DOM_GLOBALS.map((key) => [key, globals[key]] as const),
  ["requestAnimationFrame", globals.requestAnimationFrame],
  ["cancelAnimationFrame", globals.cancelAnimationFrame],
  ["getComputedStyle", globals.getComputedStyle],
]);

globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
for (const key of DOM_GLOBALS) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
globals.getComputedStyle = win.getComputedStyle.bind(win);

/** 用例收尾要还原的 console 方法（失败态用例静音预期间的错误输出）。 */
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

/** 真实 i18next 实例：本包 zh 字典 + ui-components 的 zh 字典（EmptyState 等组件的按钮文案）。 */
const i18n = createInstance();
await i18n.init({
  lng: "zh",
  fallbackLng: "zh",
  defaultNS: TICKETS_NS,
  initAsync: false,
  resources: {
    zh: { [TICKETS_NS]: ticketsResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh },
  },
});

/** 期望文案一律取自字典本体，避免在断言里另抄一份中文。 */
const TEXT = ticketsResources.zh;

// 被测页面必须在注入 DOM 全局之后动态加载：它的静态依赖链里有 streamdown（模块求值期读全局 DOM）。
const { AgentTicketDetailPage } = await import("../pages/agent-panel/pages/AgentTicketDetailPage");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER = "42";

/**
 * 宿主的薄路由壳按 `Route.useParams()` 读好 URL 参数后以 props 传给页面——props 形状是唯一的跨包契约。
 * 用例直接给这个变量赋值，等价于「地址栏里是 /agent/tickets/<projectId>/<number>」（路由 entry 也按它建）。
 */
let detailProps: { projectId: string; number: string } = { projectId: PROJECT_ID, number: NUMBER };

/** 详情路由的被测组件：只做宿主壳那一件事（读参数 → 传 props）。 */
function DetailPageRoute() {
  return createElement(AgentTicketDetailPage, detailProps);
}

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

let detailResponses: StubResponse[] = [];
let detailCalls = 0;

function jsonResponse({ status, body }: StubResponse): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map([["content-type", "application/json"]]),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith(`/web/tickets/${PROJECT_ID}/${NUMBER}`)) throw new Error(`未预期的请求：${url}`);
    const response = detailResponses[Math.min(detailCalls, detailResponses.length - 1)];
    detailCalls += 1;
    if (response === undefined) throw new Error("fetch 桩收到未配置的请求");
    return jsonResponse(response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** `/web/*` 失败信封：HTTP 状态码 + `{ success: false, error }`（`request()` 按 code 归一为 ApiError）。 */
function failure(code: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message: "boom" } } };
}

/** 详情响应：字段与后端 `TicketDetailViewSchema` 一致（`body` 是已剥离身份头的正文）。 */
function detailSuccess(overrides: Record<string, unknown> = {}): StubResponse {
  return {
    status: 200,
    body: {
      success: true,
      data: {
        ticket: {
          issueNumber: NUMBER,
          title: "登录后跳转空白页",
          state: "open",
          author: { id: "user-1", name: "张三", source: "aos" },
          assignee: null,
          labels: [],
          version: "v1",
          providerUpdatedAt: "2026-10-12T08:00:00.000Z",
          syncedAt: "2026-10-12T08:00:01.000Z",
          syncStatus: "ready",
          body: "复现步骤：点击登录后页面空白。",
          ...overrides,
        },
      },
    },
  };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

function createTestRouter() {
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent/tickets",
    component: () => createElement("div", null, "list-route"),
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent/tickets/$projectId/$number",
    component: DetailPageRoute,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [`/agent/tickets/${PROJECT_ID}/${NUMBER}`] }),
    // 与宿主的 SSR 用例同款：内存历史 + isServer 避免订阅真实 DOM 事件。
    isServer: true,
  });
}

beforeEach(() => {
  detailResponses = [detailSuccess()];
  detailCalls = 0;
  detailProps = { projectId: PROJECT_ID, number: NUMBER };
  restoreFetch = stubFetch();
  // 失败用例会经 `request()` 的失败日志与页面的 onError 打屏：静音它们，避免预期间的错误输出
  // 淹没真正的诊断（同仓库 trace / knowledge 的失败态用例同款）。
  console.error = () => {};
  console.warn = () => {};
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  restoreFetch();
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 挂载详情页并等待取数落地（ahooks 的 promise 链跨多个微任务）。 */
async function renderDetail(): Promise<void> {
  const router = createTestRouter();
  await router.load();
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(RouterProvider, { router })));
  });
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(): string {
  return container.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as HTMLButtonElement;
  }
  return;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("AgentTicketDetailPage 详情状态", () => {
  // 成功态的三样东西必须真的上屏：编号标题（`#42`）、Markdown 正文文本、作者姓名。
  // 少任何一样，用户看到的就是一个「加载完了但什么都没有」的页面。
  test("加载成功时标题、正文与作者姓名上屏", async () => {
    await renderDetail();

    expect(text()).toContain(`#${NUMBER}`);
    expect(text()).toContain("登录后跳转空白页");
    expect(text()).toContain("复现步骤：点击登录后页面空白。");
    expect(text()).toContain("张三");
    // 负责人为空时用字典的「未指派」，不能露出空白或 null。
    expect(text()).toContain(TEXT.list.unassigned);
    expect(text()).not.toContain(TEXT.loadState.failed);
  });

  // 索引降级在详情页同样是「提示而非拦截」：正文仍来自上游回源，但索引行可能不是最新，
  // 因此 stale 时必须明说；ready 时这条提示不许出现（否则它会退化成常驻噪音）。
  test("详情 syncStatus 为 stale 时显示降级提示，ready 时不显示", async () => {
    detailResponses = [detailSuccess({ syncStatus: "stale" })];
    await renderDetail();

    expect(text()).toContain(TEXT.sync.degraded);
    expect(text()).toContain("复现步骤：点击登录后页面空白。");

    act(() => {
      root.unmount();
    });
    detailResponses = [detailSuccess()];
    detailCalls = 0;
    await renderDetail();

    expect(text()).not.toContain(TEXT.sync.degraded);
  });

  // 「不存在」与「无权限」是两种持久结论：重试只会再拿一次同样的状态码，因此都不给重试按钮，
  // 但文案必须可区分——把 403 说成「工单不存在」会让用户去找一个根本不存在的工单。
  test("NOT_FOUND 与 403 各自显示对应文案且都没有重试按钮", async () => {
    detailResponses = [failure("NOT_FOUND", 404)];
    await renderDetail();

    expect(text()).toContain(TEXT.loadState.notFoundTitle);
    expect(text()).toContain(TEXT.loadState.notFoundHint);
    expect(buttonByText(TEXT.loadState.retry)).toBeUndefined();

    act(() => {
      root.unmount();
    });
    detailResponses = [failure("FORBIDDEN", 403)];
    detailCalls = 0;
    await renderDetail();

    expect(text()).toContain(TEXT.loadState.unauthorizedTitle);
    expect(text()).toContain(TEXT.loadState.unauthorizedHint);
    expect(text()).not.toContain(TEXT.loadState.notFoundTitle);
    expect(buttonByText(TEXT.loadState.retry)).toBeUndefined();
  });

  // 其余失败（网络、5xx、503 暂停）是可恢复的：必须给出重试入口，且点它要真的重新发请求并回到成功态。
  test("通用失败给重试，点重试重新请求后恢复到成功态", async () => {
    detailResponses = [failure("SERVER_ERROR", 500), detailSuccess()];
    await renderDetail();

    expect(text()).toContain(TEXT.loadState.failed);
    expect(text()).not.toContain(TEXT.loadState.notFoundTitle);
    // 服务端信封原文只允许进 console.error，不得上屏（§9.3）。
    expect(text()).not.toContain("boom");

    await click(buttonByText(TEXT.loadState.retry) as HTMLButtonElement);

    expect(detailCalls).toBe(2);
    expect(text()).toContain("复现步骤：点击登录后页面空白。");
    expect(text()).not.toContain(TEXT.loadState.failed);
  });

  // 作者归属未经受信记录核验（`source === "external"`）时必须明说「待核对」：外部自填的身份不能被
  // 当成既有事实展示，否则读者会把一个来路不明的名字当成可信作者。
  test("作者来源为 external 时显示外部来源／待核对标注", async () => {
    detailResponses = [detailSuccess({ author: { id: null, name: "路人甲", source: "external" } })];
    await renderDetail();

    expect(text()).toContain(TEXT.detail.externalAuthor);
    expect(text()).toContain(TEXT.detail.externalAuthorHint);
    // 名字仍然展示（是上游事实），但必须与「待核对」同屏出现。
    expect(text()).toContain("路人甲");
  });
});
