// web/__tests__/prod-view-list-states.test.tsx
// 三个页面加载状态的关键交互用例（§1.3(6) 的统一口径）：本包只有 ProdViewsPanel / AgentProdViewsPage /
// ProdViewPage 三个出口组件，它们的加载失败、无权限、重试必须落在**可区分且可恢复**的界面上。
//
// 为什么用真实渲染而不是读源码断言：被钉住的行为是「失败请求不会退化成空态」「重试按钮真的重新发起请求」
// 「401/403 不给重试按钮」——这三条都取决于 useRequest 的状态流转与分支顺序，源码里出现 `error` 字样
// 并不等于运行时走到了那个分支（这正是本次缺口：error 被解构却在 UI 上不可见）。
//
// 环境：happy-dom + react-dom/client（与本仓库 workflow / task 的组件用例同款）。跨包依赖不 mock，
// 只 mock `fetch`（`@fenix/web-runtime/api/request` 的唯一数据出口）与 `react-i18next` / `sonner` /
// `@tanstack/react-router`：后者会把真实库的副作用（toaster 订阅、i18n 单例初始化、路由上下文）
// 带进用例，而它们都不在本用例的观察范围内。

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
  title: "ProdView 管理",
  subtitle: "创建和管理智能体发布视图",
  create: "创建 ProdView",
  noViews: "暂无 ProdView",
  namePlaceholder: "输入视图名称",
  loadError: "加载失败：{{message}}",
  noPermission: "无权访问发布视图",
  noPermissionHint: "当前账号未被授权管理该组织的发布视图，请联系组织管理员开通权限。",
  retry: "重试",
  edit: "编辑",
  delete: "删除",
  copyLink: "复制链接",
  openView: "打开视图",
  enabled: "已启用",
  disabled: "已禁用",
  createdAt: "创建时间",
  "panel.listTitle": "发布视图",
  "panel.loadFailed": "加载视图失败",
  "panel.emptyHint": "点击 + 创建发布视图",
  "panel.createTitle": "创建发布视图",
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

// 替身给的是跨包并集（success / error / info / warning / message）：bun 1.4.2 下 `mock.module`
// 的命名空间会被同进程后续文件复用，只给本用例用到的两个方法会让之后加载的组件取到 undefined。
mock.module("sonner", () => ({
  toast: { error: () => {}, success: () => {}, info: () => {}, warning: () => {}, message: () => {} },
}));

/**
 * 路由并集替身里的 `Link`：渲染成可点的 `<a>`。
 * `params` / `search` 等参数化跳转属性不透传——本批用例只断言链接可点，不断言跳转目标。
 */
function RouterLink({ to, children, className }: { to?: string; children?: ReactNode; className?: string }) {
  return createElement("a", { href: to, className }, children);
}

/*
 * 分享页的 `useParams` 来自宿主路由单例，只为让它拿到一个视图 ID，不验证路由行为本身。
 * 返回空对象即可：`ProdViewPage` 的请求桩按队列出响应、不校验 URL，断言只落在失败/无权限分支。
 *
 * 替身必须是**跨包并集**而不是只列本用例用到的 `useParams`：bun 1.4.2 下 `mock.module` 的命名空间在
 * 被首个 import 解析后就固定下来，而 `bun test packages/` 在单进程里跑完全部包——缺 `Link` 会让之后
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

import { ProdViewsPanel } from "../pages/agent-panel/ProdViewsPanel";
import { AgentProdViewsPage } from "../pages/agent-panel/pages/AgentProdViewsPage";
import { ProdViewPage } from "../pages/prod-view/ProdViewPage";

/**
 * 聊天容器的测试替身：T5b 起 `ProdViewPage` 的聊天面板由宿主经 `chatArea` prop 注入，
 * 本文件的两个用例只走加载失败与无权限分支，永远到不了聊天渲染，因此替身渲染空内容即可。
 * 真实容器是 `apps/web` 的 `ChatArea`（本包不得引用它，见 ProdViewPage 的端口说明）。
 */
const StubChatArea = () => null;

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

const viewsPayload = [
  {
    id: "pv-1",
    organizationId: "org-1",
    name: "发布视图 A",
    description: null,
    agentId: "agent-1",
    modulesConfig: {},
    enabled: true,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

let viewResponses: StubResponse[] = [];
let viewCalls = 0;

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    // Agent 列表是页面上的次要请求，用例不关心其失败路径，恒返回空列表
    if (url.startsWith("/web/config/agents")) {
      return jsonResponse({ status: 200, body: { success: true, data: { agents: [] } } });
    }
    const next = viewResponses[Math.min(viewCalls, viewResponses.length - 1)];
    viewCalls += 1;
    return jsonResponse(next);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
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

/** 失败信封：/web/* 恒为 200 状态码 + success:false，或非 2xx + error 体，两种都要覆盖。 */
function failure(code: string, message: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

function successViews(): StubResponse {
  return { status: 200, body: { success: true, data: viewsPayload } };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  viewResponses = [];
  viewCalls = 0;
  restoreFetch = stubFetch();
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例（workflow）的做法一次性收窄
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

/** 按可访问名找按钮：图标按钮没有可见文本，只有 aria-label 能定位到它。 */
function buttonByLabel(label: string): HTMLButtonElement | undefined {
  const buttons = container.querySelectorAll("button");
  for (const button of buttons) {
    if (button.getAttribute("aria-label") === label) return button as HTMLButtonElement;
  }
  return;
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

describe("AgentProdViewsPage 列表加载状态", () => {
  test("加载失败落在持久错误分支而不是空态，且重试真的重新发起请求", async () => {
    viewResponses = [failure("SERVER_ERROR", "boom", 500), successViews()];
    await render(createElement(AgentProdViewsPage));

    // 失败后：错误分支可见（含失败原因），并且不能退化成「暂无 ProdView」空态
    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain("加载失败：boom");
    expect(text()).not.toContain("暂无 ProdView");

    const retry = buttonByText("重试");
    expect(retry).toBeDefined();
    await click(retry as HTMLButtonElement);

    // 重试后：第二次响应成功，列表渲染出来，错误分支消失
    expect(viewCalls).toBe(2);
    expect(text()).toContain("发布视图 A");
    expect(alertRegion()).toBeNull();
  });

  test("401/403 单列无权限分支且不给无意义的重试按钮", async () => {
    viewResponses = [failure("UNAUTHORIZED", "forbidden", 403)];
    await render(createElement(AgentProdViewsPage));

    expect(text()).toContain("无权访问发布视图");
    expect(text()).toContain("当前账号未被授权管理该组织的发布视图");
    expect(buttonByText("重试")).toBeUndefined();
  });

  test("行内操作按钮有可访问名（纯图标按钮靠 aria-label 命名）", async () => {
    viewResponses = [successViews()];
    await render(createElement(AgentProdViewsPage));

    for (const label of ["打开视图", "编辑", "复制链接", "删除"]) {
      expect(buttonByLabel(label)).toBeDefined();
    }
  });
});

describe("ProdViewsPanel 列表加载状态", () => {
  test("加载失败显示错误与重试，重试成功后渲染列表", async () => {
    viewResponses = [failure("SERVER_ERROR", "boom", 500), successViews()];
    await render(createElement(ProdViewsPanel, { agentId: "agent-1" }));

    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain("加载视图失败");
    // 关键回归点：失败响应（5xx 与 200 + success:false 两种形态）都不允许落进「点击 + 创建」空态
    expect(text()).not.toContain("点击 + 创建发布视图");

    await click(buttonByText("重试") as HTMLButtonElement);

    expect(viewCalls).toBe(2);
    expect(text()).toContain("发布视图 A");
    expect(alertRegion()).toBeNull();
  });

  test("请求失败不再被降级成空数组（信封为 200 + success:false 的失败同样进错误分支）", async () => {
    viewResponses = [failure("SERVER_ERROR", "boom", 200)];
    await render(createElement(ProdViewsPanel, { agentId: "agent-1" }));

    expect(alertRegion()).not.toBeNull();
    expect(text()).not.toContain("点击 + 创建发布视图");
  });

  test("401/403 单列无权限分支且不给重试按钮，创建入口仍有可访问名", async () => {
    viewResponses = [failure("UNAUTHORIZED", "forbidden", 401)];
    await render(createElement(ProdViewsPanel, { agentId: "agent-1" }));

    expect(text()).toContain("无权访问发布视图");
    expect(buttonByText("重试")).toBeUndefined();
    expect(buttonByLabel("创建发布视图")).toBeDefined();
  });
});

describe("ProdViewPage 加载状态", () => {
  test("加载失败落在持久错误分支并带可重试入口", async () => {
    viewResponses = [failure("SERVER_ERROR", "boom", 500)];
    await render(createElement(ProdViewPage, { chatArea: StubChatArea }));

    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain("boom");
    expect(buttonByText("重试")).toBeDefined();
  });

  test("401/403 走无权限分支，不给无意义的重试按钮", async () => {
    viewResponses = [failure("UNAUTHORIZED", "forbidden", 403)];
    await render(createElement(ProdViewPage, { chatArea: StubChatArea }));

    expect(text()).toContain("无权访问发布视图");
    expect(text()).toContain("当前账号未被授权管理该组织的发布视图");
    expect(buttonByText("重试")).toBeUndefined();
  });
});
