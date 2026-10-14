// web/__tests__/admin-tickets-page-states.test.tsx
// 管理台工单页（`/admin/tickets` 的页面实现）的关键状态与数据流用例。
//
// 被钉住的是四件事，它们都只在运行时的状态流转里成立：
//   1. **凭据**：请求带的是门里写入的 master key（`Authorization: Bearer …`）；401 时清掉 key 并回门，
//      而不是在面板里显示「加载失败」——那会让人以为平台本身坏了；
//   2. **四态不退化**：加载中与失败都不许落进空态（否则「请求挂了」被读成「平台里确实没有工单」）；
//   3. **失败可重试**：重试真的重发请求并渲染结果；
//   4. **分页是跨组织的统一分页**：翻页请求带 page=2，筛选变化回到第一页。
//
// 环境：happy-dom + react-dom/client。**不用 `mock.module`**：react-i18next 用真实实例 + 本包真字典
// （断言文案与字典同源），`@fenix/ui-components` 用真实组件，唯一的外部数据源是 `fetch`（直接替换
// `globalThis.fetch`）。本页不依赖路由（没有 `<Link>` 与 `useNavigate`），因此不建内存路由。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { clearAdminKey, setAdminKey } from "@fenix/web-runtime/lib/admin-key";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { TICKETS_NS, ticketsResources } from "../i18n";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 与 `request()` 在模块加载/首次请求期需要 window / document / navigator。
// 给真实 origin：happy-dom 默认的 `about:blank` 会让 URL 拼接得到字符串 "null"。
const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/** 组件与请求栈依赖的 DOM 全局构造器；`afterAll` 逐条还原（本批测试与其它文件共享进程）。 */
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
  ...["window", "document", "navigator", "sessionStorage", "location", "IS_REACT_ACT_ENVIRONMENT"].map(
    (key) => [key, globals[key]] as const,
  ),
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
  globals.sessionStorage = win.sessionStorage;
  globals.location = win.location;
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

/**
 * 真实 i18next 实例：挂本包 zh 字典 + ui-components 的 zh 字典，与断言取的是同一份资源。
 * 用真字典而不是自建 `t` 替身：文案改动时用例跟着字典走，不会出现「界面换了文案、断言还是旧的」。
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

const ADMIN_KEY = "sys-key-admin-1";

// 被测页面必须在注入 DOM 全局之后动态加载（其依赖链在模块求值期读全局 DOM）。
const { AdminTicketsPage } = await import("../pages/admin/AdminTicketsPage");

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };
type RecordedCall = { url: string; method: string; authorization: string | null };

let calls: RecordedCall[] = [];
/** `/api/system/tickets` 的响应队列；取到队尾后一直复用最后一条。 */
let listResponses: StubResponse[] = [];
let listCalls = 0;
/** 非 null 时 promise 在用例显式 resolve 之前不落地，用来观察加载态。 */
let pendingGate: { promise: Promise<void>; release: () => void } | null = null;

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
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization") });
    if (pendingGate !== null) await pendingGate.promise;
    if (!url.startsWith("/api/system/tickets")) throw new Error(`未预期的请求：${init?.method ?? "GET"} ${url}`);
    const response = nextOf(listResponses, listCalls);
    listCalls += 1;
    return jsonResponse(response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** `/api/system/*` 成功信封：`{ success: true, data }`。 */
function listPage(items: unknown[], options: { page?: number; pageSize?: number; total?: number } = {}): StubResponse {
  const pageSize = options.pageSize ?? 20;
  return {
    status: 200,
    body: {
      success: true,
      data: { items, total: options.total ?? items.length, page: options.page ?? 1, pageSize },
    },
  };
}

/** 管理面列表行：字段与后端 `SystemTicketSummaryViewSchema` 一致（含归属坐标）。 */
function row(
  overrides: { issueNumber: string; organizationId?: string; organizationName?: string } = {
    issueNumber: "7",
  },
) {
  return {
    issueNumber: overrides.issueNumber,
    title: `工单 ${overrides.issueNumber}`,
    state: "open",
    author: { id: "user-1", name: "张三", source: "aos" },
    assignee: null,
    labels: [],
    version: "v1",
    providerUpdatedAt: "2026-10-12T08:00:00.000Z",
    syncedAt: "2026-10-12T08:00:01.000Z",
    syncStatus: "ready",
    organizationId: overrides.organizationId ?? "org-alpha",
    organizationName: overrides.organizationName ?? "阿尔法组织",
    projectId: "11111111-1111-4111-8111-111111111111",
    projectName: "alpha-repo",
    projectOwner: "aos-bot",
  };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  applyDomGlobals();
  win.sessionStorage.clear();
  setAdminKey(ADMIN_KEY);
  calls = [];
  listCalls = 0;
  pendingGate = null;
  listResponses = [listPage([])];
  restoreFetch = stubFetch();
  // 失败用例会经 `request()` 的失败日志与 hooks 的 onError 打屏：静音它们，避免错误输出淹没真正的诊断。
  console.error = () => {};
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  restoreFetch();
  clearAdminKey();
  console.error = originalConsoleError;
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 挂载页面并等待取数落地（ahooks 的 promise 链跨多个微任务）。 */
async function renderPage(): Promise<void> {
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(AdminTicketsPage)));
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
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
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

const listRequests = (): RecordedCall[] => calls.filter((call) => call.url.startsWith("/api/system/tickets"));

/**
 * 向受控输入框输入文本。happy-dom 下 React 走「input 事件 polyfill」分支：`onChange` 只在**聚焦元素**的
 * keydown/keyup 上比对值变化，直接派发 `input` 或直接赋 `value` 都不会触发；而受控值又被 React 的值跟踪器
 * 比对，直接赋值会被判成「未变化」。因此按仓库既有做法用「聚焦 → 原型原生 setter 改值 → keydown」逼近真实
 * 键盘输入（口径见 `apps/web/src/__tests__/question-panel-custom-answer.test.tsx`）。
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

/** 在同一个输入框上敲 Enter（页面的键盘提交出口）。 */
async function pressEnter(element: HTMLInputElement): Promise<void> {
  await act(async () => {
    element.focus();
    element.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  });
}

describe("AdminTicketsPage 跨组织工单列表", () => {
  // 业务意图：管理面的凭据是门里写入的 master key，必须在每个请求上出现；缺了它服务端只会 401，
  // 而界面会表现成「平台没有工单」——这条断言把「凭据有没有真的带上」钉在请求上。
  test("已解锁时用 master key 请求并渲染跨组织行与归属坐标", async () => {
    listResponses = [
      listPage(
        [
          row({ issueNumber: "7", organizationId: "org-alpha", organizationName: "阿尔法组织" }),
          row({ issueNumber: "3", organizationId: "org-beta", organizationName: "贝塔组织" }),
        ],
        { total: 2 },
      ),
    ];
    await renderPage();

    const [request] = listRequests();
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(request?.url).toContain("page=1");
    expect(request?.url).toContain("pageSize=20");
    expect(text()).toContain("阿尔法组织");
    expect(text()).toContain("贝塔组织");
    // 仓库坐标由 owner/name 拼出，缺了它两个组织的同名工单号分辨不出来。
    expect(text()).toContain("aos-bot/alpha-repo");
    expect(text()).toContain(
      TEXT.admin.pageIndicator.replace("{{page}}", "1").replace("{{totalPages}}", "1").replace("{{total}}", "2"),
    );
  });

  // 业务意图：加载中不得落进空态——「还没拿到数据」与「平台里确实没有工单」是两种结论，
  // 混在一起会让人以为平台是空的（并在慢网络下反复看到错误的空态）。
  test("首屏加载中先给骨架，不落进空态", async () => {
    let release: () => void = () => {};
    pendingGate = {
      promise: new Promise((resolve) => {
        release = resolve;
      }),
      release,
    };
    listResponses = [listPage([row({ issueNumber: "7" })])];

    act(() => {
      root = createRoot(container);
    });
    await act(async () => {
      root.render(createElement(I18nextProvider, { i18n }, createElement(AdminTicketsPage)));
    });
    await flush(2);

    expect(text()).not.toContain(TEXT.admin.emptyTitle);
    expect(alertRegions().length).toBe(0);

    await act(async () => {
      release();
    });
    pendingGate = null;
    await flush();

    expect(text()).toContain("工单 7");
  });

  // 业务意图：失败必须停住（持久 role=alert + 重试），并回显服务端原因；重试要真的重发请求而不是只换 UI。
  test("加载失败渲染 role=alert 与重试，点重试重新请求后渲染结果", async () => {
    listResponses = [
      { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "platform tickets unavailable" } } },
      listPage([row({ issueNumber: "7" })]),
    ];
    await renderPage();

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.admin.loadFailedTitle);
    expect(text()).toContain(TEXT.loadState.failed.replace("{{message}}", "platform tickets unavailable"));
    expect(text()).not.toContain(TEXT.admin.emptyTitle);

    await click(buttonByText(TEXT.loadState.retry) as HTMLButtonElement);

    expect(listCalls).toBe(2);
    expect(text()).toContain("工单 7");
    expect(alertRegions().length).toBe(0);
  });

  // 业务意图：凭据失效（401）要回门重输，而不是把面板留在「加载失败」上——后者会让管理员以为平台挂了。
  // 同时清掉 sessionStorage 里的失效 key，避免下一次请求继续用它。
  test("401 时清凭据并回到密钥门", async () => {
    listResponses = [{ status: 401, body: { error: { code: "UNAUTHORIZED", message: "Invalid system API key" } } }];
    await renderPage();

    expect(text()).toContain(TEXT.admin.gateTitle);
    expect(win.sessionStorage.getItem("rcs_admin_master_key")).toBeNull();
  });

  // 业务意图：无筛选的空态与「筛选后没有匹配」是两种结论，文案不能共用；并且换筛选条件必须回到第一页，
  // 否则「第 3 页为空」会被误报成「没有匹配」。
  test("无筛选显示平台空态，筛选后为空显示未匹配并回到第一页", async () => {
    listResponses = [listPage([], { total: 0 }), listPage([])];
    await renderPage();

    expect(text()).toContain(TEXT.admin.emptyTitle);
    expect(text()).toContain(TEXT.admin.emptyHint);

    const search = container.querySelector("input") as unknown as HTMLInputElement;
    await typeInto(search, "找不到的标题");
    await pressEnter(search);
    await flush();

    expect(text()).toContain(TEXT.empty.searchTitle);
    expect(text()).not.toContain(TEXT.admin.emptyTitle);
    expect(listRequests().at(-1)?.url).toContain("page=1");
    expect(listRequests().at(-1)?.url).toContain("q=");
  });

  // 业务意图：跨组织列表必须能翻到下一页（页码语义），翻页请求带 page=2 且上一页按钮可用。
  test("翻页请求第二页并渲染新的行", async () => {
    listResponses = [
      listPage([row({ issueNumber: "7" })], { total: 21 }),
      listPage([row({ issueNumber: "6" })], { page: 2, total: 21 }),
    ];
    await renderPage();

    await click(buttonByText(TEXT.action.nextPage) as HTMLButtonElement);

    expect(listRequests().at(-1)?.url).toContain("page=2");
    expect(text()).toContain("工单 6");
  });
});
