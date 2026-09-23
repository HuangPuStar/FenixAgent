// web/__tests__/knowledge-graph-data-fetching.test.tsx
// 钉住「图谱取数从手写 `requestId` 令牌改用 `useRequest` + `AbortSignal`」之后的取数契约（§3.4）：
//   ① 失败是持久分支（`role="alert"` + 重试），不得回落成「暂无知识图谱」空态——失败与「没生成过图谱」
//      是两件事，后者（404）才该走空态；
//   ② 换知识库时旧请求被**真正取消**（`signal.abort`），迟到的旧响应不得改写新知识库的面板；
//   ③ 重试复用 `refresh`，真的重发原请求。
//
// 取数链路走**真实 `request()`**，只桩 `globalThis.fetch`：4xx/5xx → `unwrap()` 抛 `ApiError` →
// `useRequest` 的 `error` / `onError` 整条链路都在断言范围内（改成 mock 域模块会把 §5.2
// 「`request()` 对失败不 throw」这条最易错的链路藏起来）。
//
// 为什么不覆盖「取数成功后的 G6 渲染」：成功路径会 `await import("@antv/g6")` 并在真实容器里建图，
// 与本次改造无关；本文件止于「数据到手前的三态与取消」（失败 / 404 两条都不进 G6）。
//
// 环境：happy-dom + 真实 i18next 实例（挂本包 en 字典，断言取自同一份 `TEXT`），
// `react-i18next` 替身经本包共用的 `registerReactI18nextStub` 注册（理由见该文件）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { KNOWLEDGE_NS, knowledgeResources } from "../i18n";
import { registerReactI18nextStub } from "./react-i18next-stub";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT = knowledgeResources.en;

const win = new Window({ url: "https://localhost:3000" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
// happy-dom 把 DOM 构造器挂在 Window 实例上、不同步到 globalThis；radix 的 AlertDialog
// （删除确认，本文件里恒为关闭态）在挂载期仍会读到它们（同批 knowledge 用例同一处理）。
for (const key of [
  "HTMLElement",
  "HTMLDivElement",
  "SVGElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "DOMRect",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "MutationObserver",
  "ResizeObserver",
]) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined) g[key] = value;
}
g.getComputedStyle = win.getComputedStyle.bind(win);

/** 渲染用的真实 i18next 实例：挂本包 en 字典，与断言取的是同一份资源。 */
const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: KNOWLEDGE_NS,
  initAsync: false,
  resources: { en: { [KNOWLEDGE_NS]: knowledgeResources.en } },
});

registerReactI18nextStub(i18n);

afterEach(() => {
  mock.restore();
});

// ── fetch 替身：请求入队后由用例决定何时、以什么结果回应；abort 会把它移出在途队列 ──
interface PendingRequest {
  url: string;
  resolve: (response: Response) => void;
}

let pending: PendingRequest[] = [];
let requestUrls: string[] = [];
let abortedUrls: string[] = [];
let restoredFetch: typeof fetch | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "MOCK",
    headers: new Map([["content-type", "application/json"]]),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ok = <T,>(data: T) => jsonResponse({ success: true, data });
const fail = (message: string, status = 500) =>
  jsonResponse({ success: false, error: { code: "SERVER_ERROR", message } }, status);
/** 尚未生成图谱：服务端以 404 表达，不是失败。 */
const notFound = () => jsonResponse({ success: false, error: { code: "NOT_FOUND", message: "图谱不存在" } }, 404);

function stubFetch(): void {
  const originalFetch = globalThis.fetch;
  restoredFetch = originalFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requestUrls.push(url);
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const item: PendingRequest = { url, resolve };
      pending.push(item);
      if (!signal) return;
      const abort = () => {
        abortedUrls.push(url);
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
}

function respond(urlPart: string, response: Response): void {
  const index = pending.findIndex((item) => item.url.includes(urlPart));
  if (index < 0) throw new Error(`没有在途请求：${urlPart}`);
  const [item] = pending.splice(index, 1);
  item.resolve(response);
}

let root: Root | null = null;

beforeEach(() => {
  pending = [];
  requestUrls = [];
  abortedUrls = [];
  stubFetch();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  globalThis.fetch = restoredFetch as typeof fetch;
  restoredFetch = null;
});

/** 排空微任务队列（取数的 await 链全在微任务里落地）。 */
async function flushMicrotasks(times = 16): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

const { KnowledgeGraphPanel } = await import("../pages/agent-panel/KnowledgeGraphPanel");

function panel(knowledgeBaseId: string): ReactElement {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(KnowledgeGraphPanel, { knowledgeBaseId, canManage: true }),
  );
}

function render(element: ReactElement): HTMLElement {
  const container = win.document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function rerender(element: ReactElement): void {
  act(() => root?.render(element));
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").includes(text)) return button as HTMLButtonElement;
  }
  return null;
}

describe("KnowledgeGraphPanel 取数失败与取消", () => {
  // 取数失败必须落持久失败块：失败时 `graphData` 为 `null`，不给分支就会渲染「暂无知识图谱」空态，
  // 把「没取到」说成「没生成过」——用户会去做重复的生成操作。重试必须真的重发。
  test("取数失败渲染可重试的失败块并在重试后放行空态", async () => {
    const container = render(panel("kb-1"));
    await flushMicrotasks();
    expect(requestUrls[0]).toContain("/web/knowledgeBases/kb-1/graph");

    respond("kb-1/graph", fail("图谱服务不可用", 503));
    await flushMicrotasks();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain(TEXT.graph.loadFailed);
    expect(alert?.textContent).toContain("图谱服务不可用");
    // 关键区分：失败不是空态
    expect(container.textContent).not.toContain(TEXT.graph.empty);

    const retry = findButtonByText(container, TEXT.actions.retry);
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    await flushMicrotasks();
    expect(requestUrls.length).toBe(2);

    // 重试返回 404（尚未生成图谱）：此时才该走空态——404 不是失败
    respond("kb-1/graph", notFound());
    await flushMicrotasks();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(TEXT.graph.empty);
  });

  // 换知识库时旧请求必须被 `AbortSignal` 真正取消（取代此前手写的 `requestId` 令牌：令牌只能丢弃
  // 迟到的结果，请求仍在服务端跑完）。取消之后，旧知识库的响应不得改写新知识库的面板。
  test("换知识库时取消旧请求且旧响应不改写新面板", async () => {
    const container = render(panel("kb-1"));
    await flushMicrotasks();
    expect(requestUrls.length).toBe(1);

    rerender(panel("kb-2"));
    await flushMicrotasks();
    expect(requestUrls.length).toBe(2);
    expect(requestUrls[1]).toContain("/web/knowledgeBases/kb-2/graph");
    expect(abortedUrls.length).toBe(1);
    expect(abortedUrls[0]).toContain("/web/knowledgeBases/kb-1/graph");

    // 新知识库失败 → 失败块；旧知识库的响应（已取消的那一笔）不得把它顶掉
    respond("kb-2/graph", fail("图谱服务不可用", 503));
    await flushMicrotasks();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(pending.some((item) => item.url.includes("kb-1/graph"))).toBe(false);
  });

  // 404（尚未生成图谱）不是失败：直接落空态，不给失败块——否则用户第一次点开图谱面板就会看到报错。
  test("404 落空态而不是失败块", async () => {
    const container = render(panel("kb-1"));
    await flushMicrotasks();

    respond("kb-1/graph", notFound());
    await flushMicrotasks();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(TEXT.graph.empty);
    expect(container.textContent).toContain(TEXT.graph.emptyHint);
  });

  // 成功响应仍要把数据落到面板上（不渲染 G6：本环境的断言止于「数据到手」这一步的可见结果——
  // 顶部出现节点 / 关系计数栏）。
  test("取数成功渲染节点与关系计数", async () => {
    const container = render(panel("kb-1"));
    await flushMicrotasks();

    respond(
      "kb-1/graph",
      ok({
        graph: {
          nodes: [{ id: "n1", name: "退款流程", entity_type: "process" }],
          edges: [{ id: "e1", source: "n1", target: "n1", weight: 1 }],
        },
      }),
    );
    await flushMicrotasks();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain(`${TEXT.graph.nodes}: 1`);
    expect(container.textContent).toContain(`${TEXT.graph.edges}: 1`);
  });
});
