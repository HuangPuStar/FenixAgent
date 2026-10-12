// web/__tests__/agent-tickets-page-states.test.tsx
// 工单列表页「列表加载状态」的关键交互用例（对应前端合同 §8.1 第 10–13、15 条）。
//
// 为什么用真实渲染而不是读源码断言：被钉住的行为都取决于运行时的状态流转与分支顺序——
// 「失败不退化成空态」「重试真的重发请求」「401/403 不给重试按钮」「未开通时一个工单请求都不发」
// 「暂停不拦读」「索引降级只提示不拦截」「筛选后游标回到第一页」——源码里出现 `role="alert"`、
// `ready: listReady` 或 `setCursorStack([])` 字样，并不等于运行时走到了那一支。
//
// 环境：happy-dom + react-dom/client。**不用 `mock.module`**：react-i18next 用真实实例 + 本包真字典
// （断言文案与字典同源），`@tanstack/react-router` 用真实内存路由（页面用 `useNavigate`，列表行用
// `<Link>`），sonner 真实调用但无 Toaster 时静默丢弃。唯一的外部数据源是 `fetch`，用例直接替换
// `globalThis.fetch`。
//
// 写路径（创建弹窗的提交、202/201 分流与幂等键）不在本文件：它依赖 ui-components 的 Radix 弹窗，
// 而 Radix 覆盖层在同进程跑完全部包的 `bun test packages/` 里不挂载（实测：任何先加载
// `packages/ui-components/web/__tests__/message.ssr.test.tsx` 的组合下，`Portal` 的挂载 effect 不执行，
// 弹窗与 Radix Select 的内容都不上屏）。该侧的契约在 `ticket-write-outcome.test.ts` 里按
// 「请求形状 + 201/202 形状 + 表单校验规则」逐条覆盖。

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

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator。
// 给真实 origin：`request()` 与依赖它的浏览器面按 `window.location.origin` 兜底，happy-dom 默认的
// `about:blank` 会得到字符串 "null" 并在构造期抛 Invalid base URL。
const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/**
 * 组件依赖的 DOM 全局构造器。`bun test packages/` 是同进程跑完全部包，别的文件会读写这些全局，
 * 因此注入集中在 `applyDomGlobals()` 并在每个用例前重放一次；`afterAll` 还原成加载前的值。
 *
 * `HTMLElement` 与 `customElements` 必须成对注入（口径见 `@fenix/ui-components/web/testing.ts`）：
 * 只注入前者会让「有 DOM」成立而 `customElements` 仍是 undefined，之后任何求值 streamdown 链路的
 * 文件都会以 `ReferenceError: customElements is not defined` 崩在测试之间的空档里。
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
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "InputEvent",
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

/** 把 DOM 全局重新指向本用例的 window。 */
function applyDomGlobals(): void {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of DOM_GLOBALS) {
    globals[key] = (win as unknown as Record<string, unknown>)[key];
  }
  globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globals.getComputedStyle = win.getComputedStyle.bind(win);
}

applyDomGlobals();

/** 用例收尾要还原的 console 方法（失败态用例静音预期间的错误输出）。 */
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

/**
 * 真实 i18next 实例：挂本包 zh 字典 + ui-components 的 zh 字典（弹窗的「保存/取消」由后者提供），
 * 与断言取的是同一份资源。用真字典而不是自建 `t` 替身：文案改动时用例跟着字典走，
 * 不会出现「界面换了文案、断言还是旧的」。
 */
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
const { AgentTicketsPage } = await import("../pages/agent-panel/pages/AgentTicketsPage");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };
type RecordedCall = { url: string; method: string };

let calls: RecordedCall[] = [];
/** `/web/ticket-projects` 的响应队列；取到队尾后一直复用最后一条。 */
let overviewResponses: StubResponse[] = [];
/** `/web/tickets/:projectId` 列表的响应队列（含筛选与翻页）。 */
let listResponses: StubResponse[] = [];
let overviewCalls = 0;
let listCalls = 0;

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

function nextOf(queue: StubResponse[], index: number): StubResponse {
  const response = queue[Math.min(index, queue.length - 1)];
  if (response === undefined) throw new Error("fetch 桩收到未配置的请求");
  return response;
}

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });

    if (url.startsWith("/web/ticket-projects")) {
      const response = nextOf(overviewResponses, overviewCalls);
      overviewCalls += 1;
      return jsonResponse(response);
    }
    if (url.startsWith("/web/tickets/")) {
      const response = nextOf(listResponses, listCalls);
      listCalls += 1;
      return jsonResponse(response);
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** `/web/*` 失败信封：HTTP 状态码 + `{ success: false, error }`。 */
function failure(code: string, message: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

/** 组织总览：默认项目指向 `PROJECT_ID`，状态由参数决定（未开通走 `unconfigured` 且无默认项目）。 */
function overview(state: "ready" | "paused" | "unconfigured", defaultProjectId: string | null = PROJECT_ID) {
  return {
    status: 200,
    body: {
      success: true,
      data: {
        projects: defaultProjectId === null ? [] : [project(defaultProjectId)],
        defaultProjectId,
        state,
      },
    },
  } satisfies StubResponse;
}

function project(id: string) {
  return {
    id,
    organizationId: "org-1",
    bindingId: "binding-1",
    repository: {
      connectionId: "conn-1",
      providerRepositoryId: "repo-1",
      owner: "aos",
      name: "tickets",
    },
    isDefault: true,
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

/** 列表行：字段与后端 `TicketSummaryViewSchema` 一致（`issueNumber` 是字符串、`syncStatus` 只有 ready/stale）。 */
function row(issueNumber: string, options: { syncStatus?: "ready" | "stale"; title?: string } = {}) {
  return {
    issueNumber,
    title: options.title ?? `工单 ${issueNumber}`,
    state: "open",
    author: { id: "user-1", name: "张三", source: "aos" },
    assignee: null,
    labels: [],
    version: "v1",
    providerUpdatedAt: "2026-10-12T08:00:00.000Z",
    syncedAt: "2026-10-12T08:00:01.000Z",
    syncStatus: options.syncStatus ?? "ready",
  };
}

function listPage(items: unknown[], nextCursor: string | null = null): StubResponse {
  return { status: 200, body: { success: true, data: { items, nextCursor } } };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

/** 每个用例一棵新路由：列表路由挂被测页面，详情路由只为让行内 `<Link>` 有解析目标。 */
function createTestRouter() {
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent/tickets",
    component: AgentTicketsPage,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent/tickets/$projectId/$number",
    component: () => createElement("div", null, "detail-route"),
  });
  return createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/agent/tickets"] }),
    // 与宿主的 SSR 用例同款：内存历史 + isServer 避免订阅真实 DOM 事件。
    isServer: true,
  });
}

beforeEach(() => {
  applyDomGlobals();
  calls = [];
  overviewCalls = 0;
  listCalls = 0;
  overviewResponses = [overview("ready")];
  listResponses = [listPage([])];
  restoreFetch = stubFetch();
  // 失败用例会经 `request()` 的失败日志与 hooks 的 onError 打屏：静音它们，避免预期间的错误输出
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

/** 挂载页面并等待取数落地（ahooks 的 promise 链跨多个微任务）。 */
async function renderPage(): Promise<void> {
  const router = createTestRouter();
  await router.load();
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(RouterProvider, { router })));
  });
  await flush();
}

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
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
  await flush();
}

function alertRegions(): Element[] {
  return [...container.querySelectorAll('[role="alert"]')];
}

/**
 * 向受控输入框输入文本。happy-dom 下 React 走「input 事件 polyfill」分支，直接派发 `input`
 * 或直接赋 `value` 都不会让受控组件的 `onChange` 触发；按本仓库既有做法用
 * 「聚焦 → 原型上的原生 setter 改值 → keydown」三步逼近真实键盘输入（口径见
 * `apps/web/src/__tests__/question-panel-custom-answer.test.tsx`）。
 */
async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, "value")?.set;
  if (!setter) throw new Error("happy-dom 未在原型上提供 value setter");
  await act(async () => {
    element.focus();
    setter.call(element, value);
    element.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: value.slice(-1) || "a", bubbles: true }) as unknown as Event,
    );
  });
  await flush(2);
}

function listRequests(): RecordedCall[] {
  return calls.filter((call) => call.url.startsWith("/web/tickets/"));
}

describe("AgentTicketsPage 列表状态", () => {
  // 失败必须停住（持久错误分支 + 重试），不能只弹 toast 后退回「暂无工单」——那会让用户把「请求挂了」
  // 读成「确实没有工单」；同时服务端信封原文不得上屏（§9.3）。
  test("列表加载失败渲染持久 role=alert 分支且不显示空态，点重试重新发起请求", async () => {
    listResponses = [failure("SERVER_ERROR", "boom", 500), listPage([row("42")])];
    await renderPage();

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.loadState.failed);
    expect(text()).not.toContain(TEXT.empty.title);
    // 原始 message 只允许进 console.error：它在界面上出现就等于把后端内部措辞透给了用户。
    expect(text()).not.toContain("boom");

    await click(buttonByText(TEXT.loadState.retry) as HTMLButtonElement);

    expect(listCalls).toBe(2);
    expect(text()).toContain("工单 42");
    expect(alertRegions().length).toBe(0);
  });

  // 401/403 是持久授权状态：重试只会再拿一个 403，因此只展示原因、不给「点了也没用」的按钮。
  test("列表 403 显示无权限文案且没有重试按钮", async () => {
    listResponses = [failure("FORBIDDEN", "forbidden", 403)];
    await renderPage();

    expect(text()).toContain(TEXT.loadState.unauthorizedTitle);
    expect(text()).toContain(TEXT.loadState.unauthorizedHint);
    expect(buttonByText(TEXT.loadState.retry)).toBeUndefined();
  });

  // 组织未开通是「关闭语义」的硬要求：一个工单请求都不许发（不能靠「先请求、拿 404 再降级」实现），
  // 界面给持久说明而不是伪装成空列表。
  test("未开通时不发工单请求并显示未开通态", async () => {
    overviewResponses = [overview("unconfigured", null)];
    await renderPage();

    expect(text()).toContain(TEXT.disabled.title);
    expect(text()).toContain(TEXT.disabled.hint);
    expect(listRequests().length).toBe(0);
    expect(calls.filter((call) => call.url.startsWith("/web/ticket-projects")).length).toBe(1);
  });

  // 组织级暂停（`paused`）只拦写路径（服务端以 503 拒绝写），读路径照常：列表必须正常展示，
  // 不能被当成未开通——那会让用户以为整个功能没开通而去找管理员。
  test("组织暂停时列表仍可读，不落入未开通态", async () => {
    overviewResponses = [overview("paused")];
    listResponses = [listPage([row("42")])];
    await renderPage();

    expect(text()).toContain("工单 42");
    expect(text()).not.toContain(TEXT.disabled.title);
    expect(text()).not.toContain(TEXT.empty.title);
  });

  // 索引降级（行级 syncStatus=stale 派生）只提示、不拦截：数据可能不是最新但仍然可用，
  // 所以行照常渲染、顶部出现降级提示；全 ready 时这条提示必须消失（否则提示会变成常驻噪音）。
  test("任一行索引 stale 时显示降级提示且行照常渲染，全 ready 时提示消失", async () => {
    listResponses = [listPage([row("42", { syncStatus: "stale" })]), listPage([row("42", { title: "工单 42（新）" })])];
    await renderPage();

    expect(text()).toContain(TEXT.sync.degraded);
    expect(text()).toContain("工单 42");
    expect(text()).not.toContain(TEXT.empty.title);

    // 第二次响应全 ready：提示必须随数据一起消失，而刷新后的行仍在。
    await click(buttonByText(TEXT.action.refresh) as HTMLButtonElement);

    expect(listCalls).toBe(2);
    expect(text()).not.toContain(TEXT.sync.degraded);
    expect(text()).toContain("工单 42（新）");
  });

  // 筛选与分页都不落 URL：输入关键词后请求带上 q、游标回到第一页（栈被清空）。
  // 这条同时钉住「翻页用游标、筛选重置游标」的状态机——漏掉重置会让用户停在一个不存在的页上。
  test("输入关键词后请求带上 q 且游标回到第一页", async () => {
    listResponses = [listPage([row("42")], "cursor-2"), listPage([row("41")], "cursor-2"), listPage([row("40")])];
    await renderPage();

    await click(buttonByText(TEXT.action.nextPage) as HTMLButtonElement);
    expect(listRequests().at(-1)?.url).toContain("cursor=cursor-2");

    await typeInto(
      container.querySelector(`[placeholder="${TEXT.filter.searchPlaceholder}"]`) as HTMLInputElement,
      "登录",
    );
    // 关键词有 300ms 防抖：轮询等它落地（而不是睡一个固定时长），慢机器上不会假红。
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      if (listRequests().some((call) => call.url.includes("q="))) break;
    }

    const last = listRequests().at(-1);
    expect(last?.url).toContain("q=%E7%99%BB%E5%BD%95");
    expect(last?.url).not.toContain("cursor=");
  });
});
