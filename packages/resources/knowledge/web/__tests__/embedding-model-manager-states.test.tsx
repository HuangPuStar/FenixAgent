// web/__tests__/embedding-model-manager-states.test.tsx
// 向量模型管理器的取数失败分支（§3.4「失败不得映射成 empty」在本包内的最后一条缺口）。
//
// 被钉住的运行时行为，读源码断言不到：
//   1. 列表请求失败时渲染的是**失败块**（`role="alert"` + 重试），而不是「暂无已配置的模型供应商」
//      空态——失败时 `data` 停在 `undefined`、`providerCount` 同样是 0，两条分支的输入一模一样，
//      只有渲染出来才看得出走了哪一支；
//   2. 点重试真的重新发起 `POST /web/knowledgeBases/models`（不是只重置本地状态），成功后回到空态；
//   3. 失败只上屏字典文案：诊断上下文仍留在 `console.error` 里，界面不回显错误信封原文（§9.3）。
//
// 环境：happy-dom + react-dom/client（与本包两个既有组件用例同款）。跨包依赖只 mock 会把外部副作用
// 或单例带进用例的东西：
//   - `react-i18next`：**必须自己注册替身**（`registerReactI18nextStub`，理由见该文件——bun 1.4.2 的
//     `mock.module` 是进程级注册，同进程更早的文件注册过 `t: (key) => key`，不注册就会拿到 key 回显）；
//   - `sonner`：toast 需要宿主 Toaster 订阅，本用例只在需要断言「失败时也弹了瞬时提示」时观察它。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { KNOWLEDGE_NS, knowledgeResources } from "../i18n";
import { registerReactI18nextStub } from "./react-i18next-stub";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 用例期望的文案取自本包字典；渲染挂的是同一份资源，字典改了用例跟着改。 */
const TEXT = knowledgeResources.en;

/** 渲染用的真实 i18next 实例（`resources` 必须带语言维度，否则 `t()` 静默回退成 key 回显）。 */
const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: KNOWLEDGE_NS,
  initAsync: false,
  resources: { en: { [KNOWLEDGE_NS]: knowledgeResources.en } },
});

function withI18n(node: ReactElement): ReactElement {
  return createElement(I18nextProvider, { i18n }, node);
}

// 必须排在被测组件的 import 之前注册（见文件头）。
registerReactI18nextStub(i18n);

const toastErrors: string[] = [];

mock.module("sonner", () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: () => {},
    info: () => {},
    warning: () => {},
    message: () => {},
  },
}));

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = new Window({ url: "https://localhost:3000" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

const { EmbeddingModelManager } = await import("../src/pages/agent-panel/components/EmbeddingModelManager");

// ── fetch 桩：唯一的外部数据源 ──
const MODELS_URL = "/web/knowledgeBases/models";

/** 列表请求的响应队列，按调用次序取；最后一次会一直复用，便于「重试后换一种结果」。 */
let listResponses: { status: number; body: unknown }[] = [];
let listCalls = 0;

function jsonResponse({ status, body }: { status: number; body: unknown }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map([["content-type", "application/json"]]),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let restoreFetch: () => void;

beforeEach(() => {
  listResponses = [];
  listCalls = 0;
  toastErrors.length = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if ((init?.method ?? "GET") === "POST" && url.startsWith(MODELS_URL)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action !== "list") throw new Error(`用例只登记了 list 动作，收到：${body.action}`);
      const next = listResponses[Math.min(listCalls, listResponses.length - 1)];
      listCalls += 1;
      return jsonResponse(next);
    }
    throw new Error(`用例未登记的请求：${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
});

afterEach(() => {
  restoreFetch();
  mock.restore();
});

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
/** 失败路径会经过组件的 `console.error`：收集而不是打印，保持输出可读。 */
const consoleErrorCalls: unknown[][] = [];
let restoreConsoleError: () => void;

beforeEach(() => {
  consoleErrorCalls.length = 0;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
  restoreConsoleError = () => {
    console.error = originalConsoleError;
  };
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例的做法一次性收窄
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  restoreConsoleError();
});

/** 渲染并等待 fetch → unwrap → setState 与随后的 React 重渲染落定。 */
async function render(): Promise<void> {
  await act(async () => {
    root.render(withI18n(createElement(EmbeddingModelManager, { canManage: true })));
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
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
  await settle();
}

describe("EmbeddingModelManager 的取数失败分支", () => {
  // 失败时渲染失败块而不是「暂无已配置的模型供应商」空态：二者在数据上无法区分（data 都是空），
  // 只有走对分支用户才知道是「加载失败、可以重试」而不是「我确实没配过供应商」。
  test("列表请求失败时渲染失败块与重试，而不是空态", async () => {
    listResponses = [{ status: 500, body: { success: false, error: { code: "INTERNAL", message: "boom" } } }];
    await render();

    expect(text()).toContain(TEXT.embeddingModel.listLoadFailed);
    expect(text()).not.toContain(TEXT.embeddingModel.emptyTitle);
    expect(container.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
    expect(buttonByText(TEXT.embeddingModel.retry)).toBeDefined();
    // 界面只给字典文案，原始信封原文回到诊断通道（§9.3）。
    expect(text()).not.toContain("boom");
    expect(consoleErrorCalls.length).toBeGreaterThan(0);
    expect(toastErrors).toContain(TEXT.embeddingModel.listLoadFailed);
  });

  // 重试必须真的重新发起请求：成功后失败块消失、回到「确实没有供应商」的空态。
  test("点击重试重新发起请求，成功后失败块换成空态", async () => {
    listResponses = [
      { status: 500, body: { success: false, error: { code: "INTERNAL", message: "boom" } } },
      { status: 200, body: { success: true, data: [] } },
    ];
    await render();
    expect(listCalls).toBe(1);

    const retry = buttonByText(TEXT.embeddingModel.retry);
    expect(retry).toBeDefined();
    await click(retry as HTMLButtonElement);

    expect(listCalls).toBe(2);
    expect(text()).not.toContain(TEXT.embeddingModel.listLoadFailed);
    expect(text()).toContain(TEXT.embeddingModel.emptyTitle);
  });

  // 成功且确实没有供应商时才走空态：这条是上一条的反向对照，避免把空态误删成「只剩失败态」。
  test("请求成功且列表为空时渲染空态而不是失败块", async () => {
    listResponses = [{ status: 200, body: { success: true, data: [] } }];
    await render();

    expect(text()).toContain(TEXT.embeddingModel.emptyTitle);
    expect(text()).not.toContain(TEXT.embeddingModel.listLoadFailed);
    expect(container.querySelectorAll('[role="alert"]').length).toBe(0);
  });
});
