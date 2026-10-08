// web/__tests__/canvas-host-harness.tsx
// 画布宿主页用例的公共装置：happy-dom Window、fetch 路由桩、「画布 → 宿主」消息投递与「宿主 → 画布」捕获。
//
// 为什么抽成独立文件而不是各用例各写一份：两个用例文件（握手时序 / 降级分支）共用同一套 DOM 装配，
// 而 happy-dom 的全局注入必须**成对且完整**（缺一个就会在 commit 阶段 `ReferenceError`，见前端规范 §11.2），
// 两处各写一遍必然漂移。本文件不是用例（文件名不含 `.test`），不会被 `bun test` 直接加载。

import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 用例统一使用的控制台 origin（断言 `targetOrigin` 与 `event.origin` 时引用同一常量）。 */
export const CONSOLE_ORIGIN = "https://console.example.com";

const win = initializeHappyDomWindow(
  new Window({
    url: `${CONSOLE_ORIGIN}/agent/workflow/wf-1/edit`,
    // 不让 happy-dom 去加载 iframe 的 src：没有服务端时它会自行派发 load / error，让「加载失败 /
    // 初始化超时」这类断言受环境噪声影响（这两类事件由用例自己派发）。
    settings: { navigation: { disableChildFrameNavigation: true } },
  }),
);
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
// happy-dom 只把这些挂在 Window 实例上；React 与 Radix 在读全局时需要有它们。
for (const key of [
  "HTMLElement",
  "Element",
  "Node",
  "CustomEvent",
  "MutationObserver",
  "ResizeObserver",
  "MessageEvent",
]) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined) globals[key] = value;
}
globals.getComputedStyle = win.getComputedStyle.bind(win);

export { win };

// ── fetch 路由桩 ──

/** 一次被记录的请求；`body` 只在 JSON 请求体时给出。 */
export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** 路由桩的响应：状态码 + JSON 体（形状由用例自己按后端契约给）。 */
export interface FetchRoute {
  readonly status: number;
  readonly body: unknown;
}

function jsonResponse(route: FetchRoute): Response {
  return {
    ok: route.status >= 200 && route.status < 300,
    status: route.status,
    statusText: String(route.status),
    headers: new Map([["content-type", "application/json"]]),
    json: async () => route.body,
    text: async () => JSON.stringify(route.body),
  } as unknown as Response;
}

function readRequestBody(raw: BodyInit | null | undefined): unknown {
  if (typeof raw !== "string") return;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return;
  }
}

export interface FetchRouter {
  readonly calls: FetchCall[];
  /** 按 URL 片段取全部调用（顺序即发生顺序）。 */
  callsTo(fragment: string): FetchCall[];
  restore(): void;
}

/** 安装 fetch 桩：`route` 按请求返回响应，全部请求进 `calls`。 */
export function installFetchRouter(route: (call: FetchCall) => FetchRoute): FetchRouter {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: readRequestBody(init?.body),
    };
    calls.push(call);
    return jsonResponse(route(call));
  }) as typeof fetch;
  return {
    calls,
    callsTo: (fragment) => calls.filter((call) => call.url.includes(fragment)),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** 控制台面成功信封（`{ success, data }`）。 */
export function webOk(data: unknown): FetchRoute {
  return { status: 200, body: { success: true, data } };
}

/** 控制台面失败信封。 */
export function webErr(code: string, message: string, status: number): FetchRoute {
  return { status, body: { success: false, error: { code, message } } };
}

/** BFF 的上游信封成功响应（画布 SDK 依赖的形状，服务端刻意不包装）。 */
export function upstreamOk(data: unknown): FetchRoute {
  return { status: 200, body: { code: 0, msg: "success", data } };
}

/** BFF 的上游信封失败响应；票据失败必须是真实 401（冻结 §6）。 */
export function upstreamErr(status: number, msg: string): FetchRoute {
  return { status, body: { code: status, msg } };
}

// ── 渲染 ──

export interface CanvasMount {
  readonly container: HTMLElement;
  readonly root: Root;
  /** 渲染并等待取数链与随后的重渲染落定。 */
  render(node: ReactElement): Promise<void>;
  /** 推进微任务与零延时定时器，直到界面稳定。 */
  flush(): Promise<void>;
  unmount(): void;
}

export function mountCanvas(): CanvasMount {
  // happy-dom 的元素类型与全局 DOM 类型不同源：挂载用 happy-dom 的节点，对外给 DOM 视图（断言用）
  const node = win.document.createElement("div");
  win.document.body.appendChild(node);
  const container = node as unknown as HTMLElement;
  let root: Root | undefined;
  act(() => {
    root = createRoot(container);
  });
  const current = root as Root;

  const flush = async () => {
    // 请求链是 fetch → unwrap → setState 三段微任务，逐段让出事件循环后再断言
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  return {
    container,
    root: current,
    flush,
    async render(node) {
      await act(async () => {
        current.render(node);
      });
      await flush();
    },
    unmount() {
      act(() => {
        current.unmount();
      });
      container.remove();
    },
  };
}

/** 只推进微任务。配合 `jest.useFakeTimers()` 使用：假时钟下 `setTimeout(0)` 不会自己到期。 */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 容器内可见文本（断言字典键回显时用）。 */
export function textOf(container: HTMLElement): string {
  return container.textContent ?? "";
}

// ── 父子消息 ──

/** 画布 iframe 的运行时窗口（happy-dom 的 `contentWindow` 是稳定对象）。 */
export function canvasWindow(frame: HTMLIFrameElement): Record<string, unknown> {
  return frame.contentWindow as unknown as Record<string, unknown>;
}

/** 宿主发给画布的消息。 */
export interface SentMessage {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly targetOrigin: string;
}

/**
 * 接管宿主 → 画布 的 postMessage（happy-dom 的原生实现不会投递给子窗口的监听器），
 * 于是「发了什么、发给哪个 origin」都能被断言。
 */
export function captureHostMessages(frame: HTMLIFrameElement): SentMessage[] {
  const sent: SentMessage[] = [];
  canvasWindow(frame).postMessage = (data: unknown, targetOrigin: string) => {
    const envelope = data as { type: string; payload: Record<string, unknown> };
    sent.push({ type: envelope.type, payload: envelope.payload, targetOrigin });
  };
  return sent;
}

/**
 * 投递一条「画布 → 宿主」消息，`origin` / `source` 可指定：安全边界用例要伪造它们，
 * 正常用例用 `sendFromCanvas`（等价于本函数传真实 iframe 与其窗口）。
 */
export function sendRawMessage(options: {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}): void {
  win.dispatchEvent(
    new win.MessageEvent("message", {
      data: options.data,
      origin: options.origin,
      // happy-dom 的 MessageEventInit 只接受它自己的 BrowserWindow；跨类型收窄集中在这里
      source: options.source as never,
    }),
  );
}

/** 模拟画布发出的消息：同源 + `source` 指向该 iframe（两条校验都会真实生效）。 */
export function sendFromCanvas(frame: HTMLIFrameElement, type: string, payload: unknown = {}): void {
  sendRawMessage({
    data: { v: 1, id: `msg-${type}`, type, ts: Date.now(), payload },
    origin: CONSOLE_ORIGIN,
    source: frame.contentWindow,
  });
}

/** 异步投递一条画布消息并等待宿主处理完（消息处理里有 await 的网络链）。 */
export async function sendFromCanvasAsync(
  flush: () => Promise<void>,
  frame: HTMLIFrameElement,
  type: string,
  payload?: unknown,
): Promise<void> {
  await act(async () => {
    sendFromCanvas(frame, type, payload);
  });
  await flush();
}
