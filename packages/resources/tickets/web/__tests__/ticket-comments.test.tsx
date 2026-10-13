// web/__tests__/ticket-comments.test.tsx
// 评论区的数据流用例（前端合同 §10 第 6–14 条）：倒序分页与渲染顺序、新建、编辑、冲突、待确认、失败重试、
// 编辑入口的作者判定。
//
// 为什么是「真实页面 + 内联交互」（合同 §10.2 口径 A）：评论区的三个动作（新建、编辑、加载更早）与冲突提示、
// 待确认横幅都是**内联控件**，不经 Radix 覆盖层，因此能在 happy-dom 里直接 click() 驱动，断言的是
// 「请求真的发出去了（URL / body / 头）」与「真字典文案真的上屏」。覆盖层在同进程全量运行时不上挂载
//（T02 实测），本文件因此一条覆盖层断言都不写。
//
// 环境：happy-dom + react-dom/client。**不用 `mock.module`**：react-i18next 用真实实例 + 本包真字典，
// `@tanstack/react-router` 用真实内存路由（页面顶部的返回链接走真路由器），sonner 真实调用——无 Toaster
// 时 toast 不在 DOM 里，需要观察时读它自己的 `getHistory()` 记录（同 `@fenix/model-management` 的既有做法）。
// 唯一的外部数据源是 fetch，用例直接替换 `globalThis.fetch`。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { OrgSessionProvider } from "@fenix/web-runtime/contexts/org-session";
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
import { toast } from "sonner";

import { TICKETS_NS, ticketsResources } from "../i18n";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/**
 * 组件依赖的 DOM 全局构造器。`bun test packages/` 同进程跑完全部包，别的文件会读写这些全局，
 * 因此注入集中在 `applyDomGlobals()` 并在每个用例前重放一次；`afterAll` 还原成加载前的值。
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
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLTextAreaElement",
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

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

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

/** 会话投影：作者夹具的 id 是 `user-1`，会话里同样给 `user-1`——「自己的评论」才有编辑入口。 */
const ORG_SESSION = { organizationId: "org-1", userId: "user-1", isOwner: false, pending: false };

let detailProps: { projectId: string; number: string } = { projectId: PROJECT_ID, number: NUMBER };

/** 详情路由的被测组件：只做宿主壳那一件事（读参数 → 传 props）。 */
function DetailPageRoute() {
  return createElement(AgentTicketDetailPage, detailProps);
}

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };
type RecordedCall = { url: string; method: string; body: unknown; idempotencyKey: string | null };

let calls: RecordedCall[] = [];
let detailResponses: StubResponse[] = [];
let listResponses: StubResponse[] = [];
/** 新建评论的响应；用例覆盖为失败 / 202 时不改列表侧任何东西。 */
let postResponse: StubResponse;
/** 编辑评论的响应（路径里的 commentId 由用例断言）。 */
let patchResponse: StubResponse;
let detailCalls = 0;
let listCalls = 0;

function commentsPath(): string {
  return `/web/tickets/${PROJECT_ID}/${NUMBER}/comments`;
}

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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method,
      body: rawBody === undefined ? null : JSON.parse(rawBody),
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
    });

    // 评论路径必须先判：它也以详情 URL 为前缀，落到下面那条会拿详情响应冒充评论页。
    if (url.startsWith(commentsPath())) {
      if (method === "POST") return jsonResponse(postResponse);
      if (method === "PATCH") return jsonResponse(patchResponse);
      const response = listResponses[Math.min(listCalls, listResponses.length - 1)];
      listCalls += 1;
      if (response === undefined) throw new Error("fetch 桩收到未配置的评论列表请求");
      return jsonResponse(response);
    }
    if (!url.startsWith(`/web/tickets/${PROJECT_ID}/${NUMBER}`)) throw new Error(`未预期的请求：${method} ${url}`);
    const response = detailResponses[Math.min(detailCalls, detailResponses.length - 1)];
    detailCalls += 1;
    if (response === undefined) throw new Error("fetch 桩收到未配置的详情请求");
    return jsonResponse(response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** `/web/*` 失败信封：HTTP 状态码 + `{ success: false, error }`。 */
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
          pendingOperationId: null,
          ...overrides,
        },
      },
    },
  };
}

/** 评论视图：字段与后端 `TicketCommentViewSchema` 一致；作者默认是当前会话用户。 */
function comment(commentId: string, body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commentId,
    issueNumber: NUMBER,
    body,
    author: { id: "user-1", name: "张三", source: "aos" },
    version: `v-${commentId}`,
    providerUpdatedAt: "2026-10-12T09:00:00.000Z",
    ...overrides,
  };
}

/** 一页评论：接口按时间倒序给页，因此 `items` 里第一个是最新的。 */
function commentPage(items: unknown[], nextCursor: string | null = null): StubResponse {
  return { status: 200, body: { success: true, data: { items, nextCursor } } };
}

function commentWriteSuccess(commentBody: unknown, status = 200): StubResponse {
  return { status, body: { success: true, data: { comment: commentBody, operationId: "op-write" } } };
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
    isServer: true,
  });
}

beforeEach(() => {
  applyDomGlobals();
  calls = [];
  detailCalls = 0;
  listCalls = 0;
  detailProps = { projectId: PROJECT_ID, number: NUMBER };
  detailResponses = [detailSuccess()];
  listResponses = [commentPage([])];
  postResponse = commentWriteSuccess(comment("c-new", "新评论"), 201);
  patchResponse = commentWriteSuccess(comment("c1", "改后的正文"));
  restoreFetch = stubFetch();
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

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 挂载详情页并等待详情与评论首屏落地（ahooks 的 promise 链跨多个微任务）。 */
async function renderDetail(): Promise<void> {
  const router = createTestRouter();
  await router.load();
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    // Provider 链用 JSX 而不是 `createElement` 的第三参：Provider 的 props 类型把 `children` 标成必填，
    // 走第三参时 TS 不接受（TS2769），而把它当 prop 传又会撞上 biome 的 `noChildrenProp`。
    root.render(
      <OrgSessionProvider value={ORG_SESSION}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </OrgSessionProvider>,
    );
  });
  await flush();
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

function textareas(): HTMLTextAreaElement[] {
  return [...container.querySelectorAll("textarea")];
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await flush();
}

/**
 * 向受控输入框输入文本。happy-dom 下 React 走「input 事件 polyfill」分支，直接赋 `value` 不触发
 * 受控组件的 `onChange`；按本仓库既有做法用「聚焦 → 原型上的原生 setter 改值 → keydown」三步
 * 逼近真实键盘输入（口径见 `agent-tickets-page-states.test.tsx` 的同名工具）。
 */
async function typeInto(element: HTMLTextAreaElement, value: string): Promise<void> {
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

function listGets(): RecordedCall[] {
  return calls.filter((call) => call.method === "GET" && call.url.startsWith(commentsPath()));
}

function commentWrites(method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method && call.url.startsWith(commentsPath()));
}

function alertRegions(): Element[] {
  return [...container.querySelectorAll('[role="alert"]')];
}

/** 本用例新产生的 toast 文案：无 Toaster 时 toast 上不了屏，sonner 自己的记录是唯一可观测处。 */
function toastTitlesSince(index: number): string[] {
  return toast
    .getHistory()
    .slice(index)
    .flatMap((entry) => ("title" in entry && typeof entry.title === "string" ? [entry.title] : []));
}

describe("工单评论区", () => {
  // 首屏只取一页且是**最新** 30 条：这是「大讨论串」方案的硬要求——从最旧开始翻，10,000 条讨论要翻 333 次
  // 才看得到今天的回复。渲染必须把倒序分页翻回时间正序，否则读者看到的是一段倒着的对话。
  test("首屏只请求一次评论且 limit=30，三条评论按时间正序上屏", async () => {
    listResponses = [
      commentPage([comment("c3", "第三条评论"), comment("c2", "第二条评论"), comment("c1", "第一条评论")]),
    ];
    await renderDetail();

    const listCalls = listGets();
    expect(listCalls.length).toBe(1);
    expect(listCalls[0]?.url).toContain("limit=30");
    // 首屏不带游标：带上了就会从某一页中间开始读，最新一页反而永远拿不到。
    expect(listCalls[0]?.url).not.toContain("cursor=");

    const rendered = text();
    expect(rendered).toContain(TEXT.comment.sectionTitle);
    expect(rendered.indexOf("第一条评论")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("第一条评论")).toBeLessThan(rendered.indexOf("第二条评论"));
    expect(rendered.indexOf("第二条评论")).toBeLessThan(rendered.indexOf("第三条评论"));
  });

  // 「加载更早的评论」是唯一向历史翻页的入口：它必须带上上一页给的游标，且拉回来的内容要插到**最前面**
  // （比已加载的都早），否则旧评论会跑到时间线末尾，读起来仍是错乱的。
  test("加载更早的评论带 cursor 请求，并把旧评论插到列表最前", async () => {
    listResponses = [
      commentPage([comment("c3", "第三条评论"), comment("c2", "第二条评论")], "2"),
      commentPage([comment("c1", "第一条评论")]),
    ];
    await renderDetail();

    expect(buttonByText(TEXT.comment.loadMore)).toBeDefined();
    await click(buttonByText(TEXT.comment.loadMore) as HTMLButtonElement);

    const listCalls = listGets();
    expect(listCalls.length).toBe(2);
    expect(listCalls[1]?.url).toContain("cursor=2");
    expect(listCalls[1]?.url).toContain("limit=30");

    const rendered = text();
    expect(rendered.indexOf("第一条评论")).toBeLessThan(rendered.indexOf("第二条评论"));
    expect(rendered.indexOf("第二条评论")).toBeLessThan(rendered.indexOf("第三条评论"));
    // 到底之后按钮消失：`nextCursor` 为 null 还留着按钮，用户会一直点一个不再有新内容的入口。
    expect(buttonByText(TEXT.comment.loadMore)).toBeUndefined();
  });

  // 发表评论是「一次用户动作 = 一次请求」：请求体只带正文（作者由服务端从凭据确定），
  // 幂等键必须随请求发出——没有它，网络抖动后的重试会在讨论串里留下两条一样的评论。
  test("发表评论发出 POST 且带幂等键，成功后新评论出现在列表末尾", async () => {
    listResponses = [commentPage([comment("c1", "第一条评论")])];
    postResponse = commentWriteSuccess(comment("c9", "新评论内容"), 201);
    await renderDetail();

    const draft = textareas()[0] as HTMLTextAreaElement;
    await typeInto(draft, "新评论内容");
    await click(buttonByText(TEXT.comment.submit) as HTMLButtonElement);

    const posts = commentWrites("POST");
    expect(posts.length).toBe(1);
    // 评论写路径只有这一个 URL（新建不带 commentId），查询串是列表侧的事，写请求不该带上 limit。
    expect(posts[0]?.url).toBe(commentsPath());
    expect(posts[0]?.body).toEqual({ body: "新评论内容" });
    expect(posts[0]?.idempotencyKey).not.toBeNull();

    // 新评论前插到最新一页，渲染反转后落在末尾（它确实是最后发生的事）。
    const rendered = text();
    expect(rendered).toContain("新评论内容");
    expect(rendered.indexOf("第一条评论")).toBeLessThan(rendered.indexOf("新评论内容"));
    // 成功后草稿清空：留着会让用户以为没发出去而再发一遍。
    expect((textareas()[0] as HTMLTextAreaElement).value).toBe("");
  });

  // 失败必须保住草稿并允许原地重试，且重试要**复用同一把幂等键**（这是「同一次用户动作」的证据）：
  // 换键重试会让服务端的去重账本认为这是两个动作，第一次已经落地的写入就会重复。
  test("发表评论失败保留草稿且可重试，重试复用同一把幂等键", async () => {
    listResponses = [commentPage([])];
    postResponse = failure("SERVER_ERROR", 500);
    await renderDetail();

    const toastBaseline = toast.getHistory().length;
    const draft = textareas()[0] as HTMLTextAreaElement;
    await typeInto(draft, "断网时写下的评论");
    await click(buttonByText(TEXT.comment.submit) as HTMLButtonElement);

    expect(commentWrites("POST").length).toBe(1);
    expect(textareas()[0]?.value).toBe("断网时写下的评论");
    // 通用失败上屏服务端信封原文（夹具 `failure()` 的 message 是 "boom"），固定文案只在 message 为空时
    // 兜底：这里若回退成 `TEXT.comment.createFailed`，就等于又在接口侧把后端故障盖掉了。
    const failureToasts = toastTitlesSince(toastBaseline);
    expect(failureToasts).toContain("boom");
    expect(failureToasts).not.toContain(TEXT.comment.createFailed);
    // 失败不是「禁用到底」：按钮必须还能再点一次，否则用户只能刷新页面重写。
    expect((buttonByText(TEXT.comment.submit) as HTMLButtonElement).disabled).toBe(false);

    await click(buttonByText(TEXT.comment.submit) as HTMLButtonElement);

    const posts = commentWrites("POST");
    expect(posts.length).toBe(2);
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
  });

  // 202 是「结果未定」而不是成功：界面必须转入待确认态并**禁用写入口**（方案 §9.6），
  // 且不得把一条未确认的评论插进列表——那会让用户以为已经发布成功了。
  test("发表评论返回 202 时进入待确认态并禁用写入口", async () => {
    listResponses = [commentPage([])];
    postResponse = {
      status: 202,
      body: { success: true, data: { operationId: "op-202", status: "uncertain" } },
    };
    await renderDetail();

    await typeInto(textareas()[0] as HTMLTextAreaElement, "结果未定的评论");
    await click(buttonByText(TEXT.comment.submit) as HTMLButtonElement);

    const rendered = text();
    expect(rendered).toContain(TEXT.write.uncertainTitle);
    expect(rendered).toContain(TEXT.write.uncertainHint);
    expect((buttonByText(TEXT.comment.submit) as HTMLButtonElement).disabled).toBe(true);
    // 未确认的评论不得进列表：列表仍是空态，正文只躺在被禁用的输入框里（草稿，不是已发布的内容）。
    expect(rendered).toContain(TEXT.comment.empty);
  });

  // 评论编辑的 `expectedVersion` 只能来自该评论对象本身（方案 §8）：带上它，服务端才能在
  // 「读取与提交之间被人改过」时用 409 挡住静默覆盖；成功后就地替换，不整链重取。
  test("编辑自己的评论：PATCH 带上该评论版本，成功后就地更新", async () => {
    listResponses = [commentPage([comment("c1", "旧正文")])];
    patchResponse = commentWriteSuccess(comment("c1", "新正文"));
    await renderDetail();

    await click(buttonByText(TEXT.comment.edit) as HTMLButtonElement);
    // 编辑表单与新建表单同构：编辑态下输入框里的初值就是该评论正文。
    expect(textareas().length).toBe(2);
    const editor = textareas()[1] as HTMLTextAreaElement;
    expect(editor.value).toBe("旧正文");

    await typeInto(editor, "新正文");
    await click(buttonByText(TEXT.comment.save) as HTMLButtonElement);

    const patches = commentWrites("PATCH");
    expect(patches.length).toBe(1);
    expect(patches[0]?.url).toBe(`${commentsPath()}/c1`);
    expect(patches[0]?.body).toEqual({ body: "新正文", expectedVersion: "v-c1" });
    expect(patches[0]?.idempotencyKey).not.toBeNull();

    const rendered = text();
    expect(rendered).toContain("新正文");
    expect(rendered).not.toContain("旧正文");
    // 成功即退出编辑态：编辑表单消失，只剩新建评论那一个输入框。
    expect(textareas().length).toBe(1);
  });

  // 评论编辑冲突（409）：这是「有草稿的动作」，按裁定三.20 必须保留草稿、把刷新交给用户点
  // 「加载最新内容」——自动刷新会把用户刚写的文字换掉。刷新按**已加载深度**重取（此处两页），
  // 否则「加载更早」翻出来的历史会在冲突后凭空消失。
  test("评论编辑冲突保留草稿，加载最新内容按已加载深度重取", async () => {
    listResponses = [
      commentPage([comment("c3", "第三条评论"), comment("c2", "第二条评论")], "2"),
      commentPage([comment("c1", "第一条评论")]),
      commentPage([comment("c3", "第三条评论"), comment("c2", "别人改过的第二条评论")], "2"),
      commentPage([comment("c1", "第一条评论")]),
    ];
    patchResponse = failure("VERSION_CONFLICT", 409);
    await renderDetail();

    await click(buttonByText(TEXT.comment.loadMore) as HTMLButtonElement);
    await click(buttonByText(TEXT.comment.edit) as HTMLButtonElement);
    await typeInto(textareas()[1] as HTMLTextAreaElement, "我改到一半的正文");
    await click(buttonByText(TEXT.comment.save) as HTMLButtonElement);

    expect(commentWrites("PATCH").length).toBe(1);
    expect(text()).toContain(TEXT.write.conflict);
    expect(textareas()[1]?.value).toBe("我改到一半的正文");

    await click(buttonByText(TEXT.write.reload) as HTMLButtonElement);

    // 已加载两页 → 重取两页（不是只重取首页）。
    expect(listGets().length).toBe(4);
    expect(text()).not.toContain(TEXT.write.conflict);
    expect(textareas()[1]?.value).toBe("我改到一半的正文");
    expect(text()).toContain("别人改过的第二条评论");
  });

  // 列表失败不能退化成空态（「加载失败」被读成「还没有评论」会让用户以为讨论串是空的），
  // 且必须给重试入口：评论列表是回源上游的读，重试是真的可能成功。
  test("评论列表加载失败显示持久错误分支，点重试重新请求", async () => {
    listResponses = [failure("SERVER_ERROR", 500), commentPage([comment("c1", "第一条评论")])];
    await renderDetail();

    expect(alertRegions().length).toBeGreaterThanOrEqual(1);
    expect(text()).toContain(TEXT.comment.loadFailed);
    expect(text()).not.toContain(TEXT.comment.empty);

    await click(buttonByText(TEXT.loadState.retry) as HTMLButtonElement);

    expect(listGets().length).toBe(2);
    expect(text()).toContain("第一条评论");
    expect(alertRegions().length).toBe(0);
  });

  // 编辑入口只认作者本人：他人评论（含外部来源、无本地归属）不给按钮，用户就不会走一次注定 403 的往返；
  // 但评论本身照常展示，外部来源还要带上「待核对」标注。
  test("他人评论与外部来源评论都不显示编辑入口", async () => {
    listResponses = [
      commentPage([
        comment("c2", "别人的评论", { author: { id: "user-2", name: "李四", source: "aos" } }),
        comment("c1", "外部的评论", { author: { id: null, name: "路人甲", source: "external" } }),
      ]),
    ];
    await renderDetail();

    expect(text()).toContain("别人的评论");
    expect(text()).toContain("外部的评论");
    expect(text()).toContain(TEXT.detail.externalAuthor);
    expect(buttonByText(TEXT.comment.edit)).toBeUndefined();
  });
});
