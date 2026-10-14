// web/__tests__/admin-attachment-preview.test.tsx
// 平台管理面附件「点击打开」的页面级用例：带凭据取字节、图片 blob 预览、非图片下载，以及 objectURL 的
// 释放路径（关闭 / Esc / 切换 / 卸载）与失败重试。
//
// 钉住的是五件事，它们都只在运行时的状态流转里成立：
//   1. **凭据**：字节流必须走带 `Authorization` 的下载（管理面没有会话 cookie，`<img src>` / `<a href>` 都带不上）；
//   2. **图片进覆盖层**：`role="dialog"` + 文件名标题 + `blob:` 图源，关闭按钮存在（读屏与键盘入口）；
//   3. **非图片不进覆盖层**：点击即落盘（`<a download>` 记录到原文件名）；
//   4. **objectURL 必被释放**：关闭、Esc、切换到另一张、卸载（返回列表）四条路径各断言一次——不释放会一直
//      钉住那份字节；
//   5. **失败可见可重试**：覆盖层里 `role="alert"` + 重试按钮，重试成功后出图。
//
// 环境：happy-dom + react-dom/client。**不用 `mock.module`**：react-i18next 用真实实例 + 本包真字典，
// 唯一的外部数据源是 `fetch`；objectURL 与 `<a download>` 是浏览器能力，用最小替身观察副作用
// （与 `ticket-attachments.test.tsx` 的下载用例同款）。

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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
  "HTMLImageElement",
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

const originalGlobals = new Map<string, unknown>([
  ...["window", "document", "navigator", "sessionStorage", "location", "IS_REACT_ACT_ENVIRONMENT"].map(
    (key) => [key, globals[key]] as const,
  ),
  ...DOM_GLOBALS.map((key) => [key, globals[key]] as const),
  ["requestAnimationFrame", globals.requestAnimationFrame],
  ["cancelAnimationFrame", globals.cancelAnimationFrame],
  ["getComputedStyle", globals.getComputedStyle],
]);

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

const originalConsoleError = console.error;

/** 真实 i18next 实例：挂本包 zh 字典 + ui-components 的 zh 字典，与断言取的是同一份资源。 */
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
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER = "7";

const LIST_PATH = "/api/system/tickets";
const DETAIL_PATH = `${LIST_PATH}/${PROJECT_ID}/${NUMBER}`;
const COMMENTS_PATH = `${DETAIL_PATH}/comments`;
const ATTACHMENTS_PATH = `${DETAIL_PATH}/attachments`;

const { AdminTicketsPage } = await import("../pages/admin/AdminTicketsPage");

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown; binary?: boolean };
type RecordedCall = { url: string; method: string; authorization: string | null };

let calls: RecordedCall[] = [];
let routes = new Map<string, StubResponse[]>();
let routeCalls = new Map<string, number>();

/** 浏览器能力替身：objectURL 的创建与释放是这层的核心副作用，必须逐条观察。 */
let createdObjectUrls: string[] = [];
let revokedObjectUrls: string[] = [];
/** `<a download>` 的落盘记录（非图片路径）。 */
let savedFiles: { href: string; download: string }[] = [];
/** 被替换的浏览器能力原实现，`afterEach` 逐条还原（本批测试与其它文件共享进程）。 */
let originalCreateObjectUrl: typeof URL.createObjectURL;
let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
let originalAnchorClick: typeof HTMLAnchorElement.prototype.click;

function jsonResponse({ status, body, binary }: StubResponse): Response {
  if (binary === true) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map([["content-type", "application/octet-stream"]]),
      blob: async () => new Blob([body as unknown as BlobPart]),
    } as unknown as Response;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map([["content-type", "application/json"]]),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function route(method: string, path: string, ...responses: StubResponse[]): void {
  routes.set(`${method} ${path}`, responses);
}

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method, authorization: new Headers(init?.headers).get("authorization") });

    const [pathname] = url.split("?");
    const key = `${method} ${pathname}`;
    const queue = routes.get(key);
    if (queue === undefined) throw new Error(`未预期的请求：${key}`);
    const index = routeCalls.get(key) ?? 0;
    routeCalls.set(key, index + 1);
    return jsonResponse(queue[Math.min(index, queue.length - 1)]);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** `/api/system/*` 成功信封：`{ success: true, data }`。 */
function ok(data: unknown, status = 200): StubResponse {
  return { status, body: { success: true, data } };
}

/** `/api/system/*` 失败信封：`{ error: { code, message } }`（**没有** `success: false`，与 `/web` 面不同）。 */
function fail(status: number, code: string, message = "boom"): StubResponse {
  return { status, body: { error: { code, message } } };
}

// ── 夹具 ──
function row() {
  return {
    issueNumber: NUMBER,
    title: `工单 ${NUMBER}`,
    state: "open",
    author: { id: "user-1", name: "张三", source: "aos" },
    assignee: null,
    labels: [],
    version: "v1",
    providerUpdatedAt: "2026-10-12T08:00:00.000Z",
    syncedAt: "2026-10-12T08:00:01.000Z",
    syncStatus: "ready",
    organizationId: "org-alpha",
    organizationName: "阿尔法组织",
    projectId: PROJECT_ID,
    projectName: "alpha-repo",
    projectOwner: "aos-bot",
  };
}

function detailSuccess(): StubResponse {
  return ok({
    ticket: {
      ...row(),
      body: "复现步骤：点击登录后页面空白。",
      pendingOperationId: null,
    },
  });
}

function attachment(attachmentId: string, name: string): Record<string, unknown> {
  return { attachmentId, name, size: 3, createdAt: "2026-10-12T09:00:00.000Z" };
}

function routeDefaults(items: unknown[]): void {
  route("GET", LIST_PATH, ok({ items: [row()], total: 1, page: 1, pageSize: 20 }));
  route("GET", DETAIL_PATH, detailSuccess());
  route("GET", COMMENTS_PATH, ok({ items: [], nextCursor: null }));
  route("GET", ATTACHMENTS_PATH, ok({ items }));
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
  routes = new Map();
  routeCalls = new Map();
  createdObjectUrls = [];
  revokedObjectUrls = [];
  savedFiles = [];
  originalCreateObjectUrl = URL.createObjectURL;
  originalRevokeObjectUrl = URL.revokeObjectURL;
  originalAnchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => {
    const url = `blob:test-${createdObjectUrls.length + 1}`;
    createdObjectUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedObjectUrls.push(url);
  };
  win.HTMLAnchorElement.prototype.click = function clickStub(this: HTMLAnchorElement) {
    savedFiles.push({ href: this.href, download: this.download });
  };
  restoreFetch = stubFetch();
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
  // 浏览器能力只在用例期间替换：宿主实现（或下一批测试）必须看到原样。
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
  win.HTMLAnchorElement.prototype.click = originalAnchorClick;
  clearAdminKey();
  console.error = originalConsoleError;
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

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

function visibleView(): HTMLElement {
  for (const child of [...container.children]) {
    if (!(child as HTMLElement).hidden) return child as HTMLElement;
  }
  throw new Error("没有可见视图");
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  const buttons = [...visibleView().querySelectorAll("button")] as unknown as HTMLButtonElement[];
  return buttons.find((button) => (button.textContent ?? "").trim() === label);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function openRowFromList(): Promise<void> {
  const rows = [...visibleView().querySelectorAll("tbody tr")];
  const cell = [...(rows[0]?.querySelectorAll("td") ?? [])][2];
  if (cell === undefined) throw new Error("列表未渲染可点的行");
  await click(cell as unknown as HTMLElement);
}

/** 点某个附件的「打开」入口（文件名按钮，`aria-label` 是「打开 {{name}}」）。 */
async function openAttachment(name: string): Promise<void> {
  const label = TEXT.attachment.open.replace("{{name}}", name);
  const target = [...visibleView().querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
  if (target === undefined) throw new Error(`附件行未渲染打开入口：${name}`);
  await click(target as unknown as HTMLButtonElement);
}

function dialog(): Element | null {
  return visibleView().querySelector('[role="dialog"]');
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    // 派发到全局 `document`（被测组件监听的正是它）：`win.document` 是 happy-dom 的 Document 类型，
    // 它的 `dispatchEvent` 只接受 happy-dom 的 Event，而这里的键盘事件是替身。
    document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  await flush(2);
}

const downloadRequests = (attachmentId: string): RecordedCall[] =>
  calls.filter((call) => call.url.split("?")[0] === `${ATTACHMENTS_PATH}/${attachmentId}`);

describe("管理面附件预览", () => {
  // 业务意图：管理面的图源必须带凭据取回——`<img src>` 带不上 `Authorization`，因此点击「打开」要发一次带
  // master key 的下载请求，取回的字节转成 objectURL 才进覆盖层；覆盖层要有标题（文件名）与关闭按钮。
  test("图片点击打开：带凭据取字节并在覆盖层预览", async () => {
    routeDefaults([attachment("8", "复现截图.png")]);
    route("GET", `${ATTACHMENTS_PATH}/8`, { status: 200, body: new Uint8Array([1, 2, 3]), binary: true });
    await renderPage();
    await openRowFromList();

    await openAttachment("复现截图.png");

    const [request] = downloadRequests("8");
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(createdObjectUrls).toEqual(["blob:test-1"]);

    const preview = dialog();
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("复现截图.png");
    const image = preview?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:test-1");
    expect(image?.getAttribute("alt")).toBe("复现截图.png");
    expect(buttonByText(TEXT.attachment.closePreview)).toBeDefined();
  });

  // 业务意图：预览是覆盖层，必须能关；objectURL 不释放会把那份字节一直钉在内存里，因此关闭与 Esc 两条路径
  // 都要断言「撤销了同一个地址」。
  test("关闭与 Esc 都撤掉覆盖层并释放 objectURL", async () => {
    routeDefaults([attachment("8", "复现截图.png")]);
    route("GET", `${ATTACHMENTS_PATH}/8`, { status: 200, body: new Uint8Array([1, 2, 3]), binary: true });
    await renderPage();
    await openRowFromList();

    await openAttachment("复现截图.png");
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(revokedObjectUrls).toEqual(["blob:test-1"]);

    await openAttachment("复现截图.png");
    expect(dialog()).not.toBeNull();
    const close = buttonByText(TEXT.attachment.closePreview);
    if (close === undefined) throw new Error("覆盖层未渲染关闭按钮");
    await click(close);
    expect(dialog()).toBeNull();
    expect(revokedObjectUrls).toEqual(["blob:test-1", "blob:test-2"]);
  });

  // 业务意图：取字节失败要看得见（role=alert + 原因）并且能就地重试；重试成功后同一个覆盖层出图，不再多开一层。
  test("加载失败显示错误与重试，重试成功后出图", async () => {
    routeDefaults([attachment("8", "复现截图.png")]);
    route("GET", `${ATTACHMENTS_PATH}/8`, fail(503, "GIT_UNAVAILABLE", "上游不可用"), {
      status: 200,
      body: new Uint8Array([1, 2, 3]),
      binary: true,
    });
    await renderPage();
    await openRowFromList();

    await openAttachment("复现截图.png");

    const error = dialog()?.querySelector('[role="alert"]');
    expect(error?.textContent).toContain(TEXT.attachment.previewFailed);
    expect(error?.textContent).toContain("上游不可用");
    expect(dialog()?.querySelector("img")).toBeNull();

    const retry = buttonByText(TEXT.loadState.retry);
    if (retry === undefined) throw new Error("失败态未渲染重试按钮");
    await click(retry);

    expect(downloadRequests("8").length).toBe(2);
    expect(dialog()?.querySelector("img")?.getAttribute("src")).toBe("blob:test-1");
  });

  // 业务意图：非图片没有可预览的内容，点击即落盘（`<a download>` 记录到原文件名），并且**不开**覆盖层——
  // 开一层只能看「无法显示」的空白，比直接下载更差。
  test("非图片点击即下载，不进预览覆盖层", async () => {
    routeDefaults([attachment("9", "日志.txt")]);
    route("GET", `${ATTACHMENTS_PATH}/9`, { status: 200, body: new Uint8Array([1, 2, 3]), binary: true });
    await renderPage();
    await openRowFromList();

    await openAttachment("日志.txt");

    expect(downloadRequests("9")[0]?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(savedFiles).toEqual([{ href: "blob:test-1", download: "日志.txt" }]);
    expect(dialog()).toBeNull();
    expect(createdObjectUrls).toEqual(["blob:test-1"]);

    // 连点两次：前一次落盘被取消（共用同一条在途通道），只写出一份文件。
    const label = TEXT.attachment.open.replace("{{name}}", "日志.txt");
    const opener = [...visibleView().querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === label,
    );
    if (opener === undefined) throw new Error("附件行未渲染打开入口：日志.txt");
    savedFiles = [];
    await act(async () => {
      (opener as unknown as HTMLButtonElement).click();
      (opener as unknown as HTMLButtonElement).click();
    });
    await flush();
    expect(savedFiles.length).toBe(1);
  });

  // 业务意图：objectURL 的另两条释放路径——切换到另一张图（旧地址立刻撤销）与卸载（返回列表）。
  test("切换预览释放上一张，返回列表释放当前", async () => {
    routeDefaults([attachment("8", "第一张.png"), attachment("9", "第二张.png")]);
    route("GET", `${ATTACHMENTS_PATH}/8`, { status: 200, body: new Uint8Array([1, 2, 3]), binary: true });
    route("GET", `${ATTACHMENTS_PATH}/9`, { status: 200, body: new Uint8Array([4, 5, 6]), binary: true });
    await renderPage();
    await openRowFromList();

    await openAttachment("第一张.png");
    expect(dialog()?.querySelector("img")?.getAttribute("src")).toBe("blob:test-1");

    await openAttachment("第二张.png");
    expect(dialog()?.querySelector("img")?.getAttribute("src")).toBe("blob:test-2");
    expect(revokedObjectUrls).toEqual(["blob:test-1"]);

    const back = buttonByText(TEXT.action.back);
    if (back === undefined) throw new Error("详情未渲染返回按钮");
    await click(back);
    expect(revokedObjectUrls).toEqual(["blob:test-1", "blob:test-2"]);
    // 回到列表视图（详情与覆盖层都卸载了）。
    expect(visibleView().querySelectorAll("tbody tr").length).toBe(1);
    expect(dialog()).toBeNull();
  });
});
