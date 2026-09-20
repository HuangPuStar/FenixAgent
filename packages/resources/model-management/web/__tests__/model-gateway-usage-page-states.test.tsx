// web/__tests__/model-gateway-usage-page-states.test.tsx
// 用量页失败分支的渲染级用例：被钉住的行为是「无权限不给重试按钮」「上游失败给重试按钮，且重试真的重新
// 发起请求」——两条都取决于 `useRequest` 的状态流转与分支顺序，纯逻辑单测（`model-gateway-usage-failure`）
// 只能证明分类函数，证明不了页面真的按分类渲染。
//
// 服务端侧的配套断言在 `src/__tests__/web-model-gateway-usage-route.test.ts`：不可见 Provider 必须是
// 403（前端归一为 UNAUTHORIZED），上游失败必须是 400。两侧合起来才是「永远失败的重试按钮」被消除。
//
// 环境：happy-dom + react-dom/client（与本仓库 prod-view / workflow 的组件用例同款）。跨包依赖不 mock，
// 只 mock `fetch`（`@fenix/web-runtime/api/request` 的唯一数据出口）与 `react-i18next` /
// `@tanstack/react-router`：后者会把真实库的副作用（i18n 单例初始化、路由上下文）带进用例，而它们都不在
// 本用例的观察范围内。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = new Window();
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

/** 用例断言到的键，按 zh 字典取值；未登记的键回显自身，便于快速发现漏登记的断言目标。 */
const MOCK_TRANSLATIONS: Record<string, string> = {
  "gateway.forbidden": "你没有查看该模型网关用量的权限。",
  "gateway.loadError": "加载模型网关用量失败，请稍后重试。",
  "gateway.loading": "正在加载用量…",
  "gateway.usageTitle": "我的用量 · {{providerName}}",
  "gateway.noData": "暂无数据",
  "actions.retry": "重试",
};

/**
 * `react-i18next` 替身的跨包并集出口：`useTranslation` 由本文件自带翻译表，
 * 其余出口给同签名直通版本——bun 1.4.2 下 `mock.module` 的命名空间会被同进程后续文件复用，
 * 缺少 `I18nextProvider` 会让之后加载的组件（如 identity 的弹窗）在渲染期直接抛错。
 */
const REACT_I18NEXT_UNION = {
  I18nextProvider: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children?: unknown }) => children,
};

mock.module("react-i18next", () => ({
  ...REACT_I18NEXT_UNION,
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let result = MOCK_TRANSLATIONS[key] ?? key;
      for (const [name, value] of Object.entries(opts ?? {})) {
        result = result.replace(`{{${name}}}`, String(value));
      }
      return result;
    },
  }),
}));

/**
 * 路由并集替身里的 `Link`：渲染成可点的 `<a>`。
 * `params` / `search` 等参数化跳转属性不透传——本批用例只断言链接可点，不断言跳转目标。
 */
function RouterLink({ to, children, className }: { to?: string; children?: ReactNode; className?: string }) {
  return createElement("a", { href: to, className }, children);
}

/*
 * 返回按钮走宿主路由单例，只为让页面拿到一个 navigate，不验证路由行为本身。
 *
 * 替身必须是**跨包并集**而不是只列本用例用到的 `useNavigate`：bun 1.4.2 下 `mock.module` 的命名空间
 * 在被首个 import 解析后就固定下来，而 `bun test packages/` 在单进程里跑完全部包——缺 `Link` 会让之后
 * 加载的跨包组件在链接期抛 `SyntaxError: Export named 'Link' not found`（整批用例 0.05ms 全红）。
 */
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useSearch: () => ({}),
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
  Link: RouterLink,
}));

afterEach(() => {
  mock.restore();
});

import { ModelGatewayUsagePage } from "../pages/agent-panel/pages/ModelGatewayUsagePage";

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

let usageResponses: StubResponse[] = [];
let usageCalls = 0;

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
    if (!url.startsWith("/web/model-gateway/")) {
      throw new Error(`用例未预期的请求：${url}`);
    }
    const next = usageResponses[Math.min(usageCalls, usageResponses.length - 1)];
    usageCalls += 1;
    return jsonResponse(next);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 失败信封：`/web/*` 的失败体是 `{ success: false, error: { code, message } }`。 */
function failure(code: string, message: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

/** 成功响应：该端点返回裸对象（没有 `success` / `data` 包裹），与线上一致。 */
function successUsage(): StubResponse {
  return {
    status: 200,
    body: {
      gatewayProvider: { id: "provider-1", name: "fenix-model-gateway", displayName: "全局模型网关" },
      totalSpendUsd: 0,
      records: [],
      activeUserCount: 0,
      byAgent: [],
      byModel: [],
      budget: { maxBudgetUsd: null, duration: null, spendUsd: 0, resetAt: null },
    },
  };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  usageResponses = [];
  usageCalls = 0;
  restoreFetch = stubFetch();
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例（prod-view）的做法一次性收窄
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
  restoreFetch();
});

/** 渲染并等待 useRequest 的 promise 链与随后的 React 重渲染落定。 */
async function render(node: ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  // 请求链是 fetch → unwrap → setState 三段微任务，逐段让出事件循环后再断言
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
  const buttons = container.querySelectorAll("button");
  for (const button of buttons) {
    if ((button.textContent ?? "").trim() === label) return button as HTMLButtonElement;
  }
  return;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function alertRegion(): Element | null {
  return container.querySelector('[role="alert"]');
}

/** 页面只接受 providerId 一个 prop；路由参数由宿主注入。 */
function page() {
  return createElement(ModelGatewayUsagePage, { providerId: "provider-1" });
}

describe("ModelGatewayUsagePage 失败分支", () => {
  // 403（Provider 不可见）是终态：只给原因、不给重试按钮，否则用户会对着必然失败的按钮反复点击。
  test("403 落在无权限分支且不给重试按钮", async () => {
    usageResponses = [failure("UNAUTHORIZED", "forbidden", 403)];
    await render(page());

    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain("你没有查看该模型网关用量的权限。");
    expect(text()).not.toContain("加载模型网关用量失败，请稍后重试。");
    expect(buttonByText("重试")).toBeUndefined();
    expect(usageCalls).toBe(1);
  });

  // 400（上游/网关类失败）可自愈：给出错误原因与重试入口，且重试真的重新发起请求并渲染成功态。
  test("400 落在可重试分支，重试重新发起请求", async () => {
    usageResponses = [failure("MODEL_GATEWAY_ERROR", "upstream unavailable", 400), successUsage()];
    await render(page());

    expect(text()).toContain("加载模型网关用量失败，请稍后重试。");
    const retry = buttonByText("重试");
    expect(retry).toBeDefined();

    await click(retry as HTMLButtonElement);

    expect(usageCalls).toBe(2);
    expect(alertRegion()).toBeNull();
    // 成功态渲染了网关摘要（标题插值）与空的分组表：证明第二次请求的数据真的进了页面。
    expect(text()).toContain("我的用量 · 全局模型网关");
    expect(text()).toContain("暂无数据");
  });
});
