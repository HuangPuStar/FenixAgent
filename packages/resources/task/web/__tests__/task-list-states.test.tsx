// web/__tests__/task-list-states.test.tsx
// 定时任务页面「列表加载状态」的关键交互用例（§1.3(6) 的统一口径）：加载失败、无权限、重试
// 必须落在**可区分且可恢复**的界面上；行内交互控件不得嵌套在伪造的 button 容器里。
//
// 为什么用真实渲染而不是读源码断言：被钉住的行为是「失败请求不会退化成空态」「重试真的重新发起请求」
// 「401/403 不给重试按钮」「点开关不会顺带切换选中任务」——这四条都取决于 useRequest 的状态流转、
// 分支顺序与 DOM 事件冒泡，源码里出现 `error` 字样并不等于运行时走到了那个分支（这正是本次缺口：
// error 被解构/被降级，UI 上却不可见）。
//
// 环境：happy-dom + react-dom/client（与本仓库 prod-view / workflow 的组件用例同款）。跨包依赖不 mock，
// 只 mock 会把外部副作用或上下文依赖带进用例的四处：`fetch`（唯一数据源）、`react-i18next`（真实库要
// 初始化单例并注册资源）、`sonner`（toaster 订阅）、`@tanstack/react-router`（TasksPanel 顶部的
// `<Link>` 需要路由上下文，用例不装配整个 Router，只换掉 `Link` 本身）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator。
// 必须给一个真实 origin：本包经 `@fenix/ui-components` → identity 的浏览器面间接触达 better-auth 的
// `createAuthClient({ baseURL: "" })`，它按 `window.location.origin` 兜底，happy-dom 默认的
// `about:blank` 会得到字符串 "null" 并在构造期抛 Invalid base URL（与本包改动无关）。
const win = new Window({ url: "https://localhost:3000" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

/** 用例断言到的键，按 zh 字典取值；未登记的键回显自身，便于快速发现漏登记的断言目标。 */
const MOCK_TRANSLATIONS: Record<string, string> = {
  title: "定时任务",
  subtitle: "管理 HTTP 请求和 Agent 调用的定时执行",
  empty: "暂无定时任务",
  emptySearchResult: "没有匹配的任务",
  "panelMode.tasksEmpty": "暂无绑定的定时任务",
  "panelMode.tasksListTitle": "任务列表",
  "panelMode.tasksLoadFailed": "加载任务列表失败",
  "panelMode.tasksManage": "前往管理",
  "loadState.failed": "任务加载失败：{{message}}",
  "loadState.unauthorizedTitle": "无权访问定时任务",
  "loadState.unauthorizedHint": "当前账号未被授权查看该组织的定时任务，请联系组织管理员开通权限。",
  "loadState.retry": "重试",
  "action.execute": "执行",
  "action.more": "更多操作",
  "card.enabled": "启用",
  "card.disabled": "停用",
  "log.title": "执行日志 - {{name}}",
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
 * 替身给的是**跨包并集**而不是只换掉 `Link`：bun 1.4.2 下 `mock.module` 的命名空间在被首个 import
 * 解析后就固定下来，而 `bun test packages/` 在单进程里跑完全部包——任一文件只登记部分出口，都会让
 * 之后加载的跨包组件在链接期抛 `SyntaxError: Export named 'Link' / 'useParams' not found`。
 * 并集口径 = 全仓库 packages 内真实出现过的路由出口；各文件注册同一份，谁先注册结果都一致。
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

const { AgentTasksPage } = await import("../pages/agent-panel/pages/AgentTasksPage");
const { TasksPanel } = await import("../pages/agent-panel/TasksPanel");

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

const taskPayload = [
  {
    id: "task-1",
    name: "每日备份",
    description: null,
    cron: "*/5 * * * *",
    timezone: null,
    enabled: true,
    timeoutSeconds: 300,
    agentId: null,
    type: "http",
    definition: { url: "https://example.com/hook", method: "POST" },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: "success",
    createdAt: 1767225600,
    updatedAt: 1767225600,
  },
  {
    id: "task-2",
    name: "报表导出",
    description: null,
    cron: "0 9 * * *",
    timezone: null,
    enabled: true,
    timeoutSeconds: 300,
    agentId: null,
    type: "http",
    definition: { url: "https://example.com/report", method: "POST" },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: "success",
    createdAt: 1767225600,
    updatedAt: 1767225600,
  },
];

const logPayload = [
  {
    id: "log-1",
    taskId: "task-1",
    status: "success",
    triggeredBy: "manual",
    duration: 12,
    resultSummary: "ok-summary",
    skipReason: null,
    error: null,
    createdAt: 1767225600,
  },
];

let listResponses: StubResponse[] = [];
let listCalls = 0;
let logResponses: StubResponse[] = [];
let logCalls = 0;
let toggleCalls = 0;

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
    // Agent 列表是页面上的次要请求，用例不关心其失败路径，恒返回空列表
    if (url.startsWith("/web/config/agents")) {
      return jsonResponse({ status: 200, body: { success: true, data: { agents: [] } } });
    }
    // 日志端点必须先于列表判断：/web/tasks/v2/<id>/logs 同样以列表前缀开头
    if (url.includes("/logs")) {
      const next = logResponses[Math.min(logCalls, logResponses.length - 1)];
      logCalls += 1;
      return jsonResponse(next);
    }
    if (url.includes("/toggle")) {
      toggleCalls += 1;
      return jsonResponse({ status: 200, body: { success: true, data: { id: "task-1", enabled: false } } });
    }
    const next = listResponses[Math.min(listCalls, listResponses.length - 1)];
    listCalls += 1;
    return jsonResponse(next);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 失败信封：/web/* 恒为 200 状态码 + success:false，或非 2xx + error 体，两种都要覆盖。 */
function failure(code: string, message: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

function successList(): StubResponse {
  return { status: 200, body: { success: true, data: { items: taskPayload, total: 2, page: 1, pageSize: 20 } } };
}

function successLogs(): StubResponse {
  return { status: 200, body: { success: true, data: { items: logPayload, total: 1, page: 1, pageSize: 20 } } };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  listResponses = [];
  listCalls = 0;
  logResponses = [];
  logCalls = 0;
  toggleCalls = 0;
  restoreFetch = stubFetch();
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

/** 按可访问名找按钮：纯图标按钮没有可见文本，只有 aria-label 能定位到它。 */
function buttonByLabel(label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if (button.getAttribute("aria-label") === label) return button as HTMLButtonElement;
  }
  return;
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
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function alertRegions(): Element[] {
  return [...container.querySelectorAll('[role="alert"]')];
}

describe("AgentTasksPage 列表加载状态", () => {
  // 失败必须停住（持久错误分支 + 原因 + 重试），不能只弹 toast 后退回「暂无任务」空态
  test("加载失败落在持久错误分支而不是空态，且重试真的重新发起请求", async () => {
    listResponses = [failure("SERVER_ERROR", "boom", 500), successList()];
    await render(createElement(AgentTasksPage));

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain("任务加载失败：boom");
    expect(text()).not.toContain("暂无定时任务");

    await click(buttonByText("重试") as HTMLButtonElement);

    // 重试后：第二次响应成功，列表渲染出来，错误分支消失
    expect(listCalls).toBe(2);
    expect(text()).toContain("每日备份");
    expect(alertRegions().length).toBe(0);
  });

  // 401/403 是持久授权状态：单列无权限分支并说明原因，不给「点了也没用」的重试按钮
  test("401/403 单列无权限分支且不给重试按钮", async () => {
    listResponses = [failure("UNAUTHORIZED", "forbidden", 403)];
    await render(createElement(AgentTasksPage));

    expect(text()).toContain("无权访问定时任务");
    expect(text()).toContain("当前账号未被授权查看该组织的定时任务");
    expect(buttonByText("重试")).toBeUndefined();
  });

  // 行内纯图标控件必须有可访问名：下拉触发器曾只有三个点，读屏与测试都定位不到它
  test("行内图标操作有可访问名（执行 / 更多操作）", async () => {
    listResponses = [successList()];
    await render(createElement(AgentTasksPage));

    expect(buttonByLabel("执行")).toBeDefined();
    expect(buttonByLabel("更多操作")).toBeDefined();
  });
});

describe("TasksPanel 列表加载状态", () => {
  // 侧栏面板同样要能区分「加载失败」与「没有绑定任务」，并给出重试入口
  test("加载失败显示持久错误分支与重试，重试成功后渲染列表", async () => {
    listResponses = [failure("SERVER_ERROR", "boom", 500), successList()];
    logResponses = [successLogs()];
    await render(createElement(TasksPanel, { agentId: "agent-1" }));

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain("加载任务列表失败");
    expect(text()).not.toContain("暂无绑定的定时任务");

    await click(buttonByText("重试") as HTMLButtonElement);

    expect(listCalls).toBe(2);
    expect(text()).toContain("每日备份");
    expect(alertRegions().length).toBe(0);
  });

  // 无权限分支在侧栏同样不给重试：再点一次只会拿到同一个 403
  test("401/403 单列无权限分支且不给重试按钮", async () => {
    listResponses = [failure("UNAUTHORIZED", "forbidden", 401)];
    await render(createElement(TasksPanel, { agentId: "agent-1" }));

    expect(text()).toContain("无权访问定时任务");
    expect(buttonByText("重试")).toBeUndefined();
  });

  // 行内控件曾嵌在 role="button" 的容器里（旧实现靠 e.stopPropagation 掩盖症状）：
  // 现在选择区是真按钮，点开关不会顺带切换选中任务
  test("行内开关不再顺带切换选中任务（操作控件已移出伪 button 容器）", async () => {
    listResponses = [successList()];
    logResponses = [successLogs()];
    await render(createElement(TasksPanel, { agentId: "agent-1" }));

    const rowButtons = () => [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(rowButtons().length).toBe(2);
    // 列表加载后默认选中第一条
    expect(rowButtons()[0].getAttribute("aria-pressed")).toBe("true");
    // 行容器不再伪造 button 角色（Switch/Button 曾嵌在里面），且不存在按钮套按钮
    expect(container.querySelectorAll('[role="button"]').length).toBe(0);
    expect(container.querySelectorAll("button button").length).toBe(0);

    // 选中区仍是真按钮：点第二行即切换选中，日志区跟着换任务
    await click(rowButtons()[1]);
    expect(rowButtons()[1].getAttribute("aria-pressed")).toBe("true");
    expect(text()).toContain("执行日志 - 报表导出");

    // 点开关只触发开关自身：选中任务不变（这正是旧实现用 e.stopPropagation() 掩盖的嵌套控件症状）
    await click(buttonByLabel("停用") as HTMLButtonElement);
    expect(toggleCalls).toBe(1);
    expect(rowButtons()[1].getAttribute("aria-pressed")).toBe("true");
  });

  // 日志区失败同样要有可恢复入口：给出原因并允许重发同页请求
  test("日志区加载失败给出原因与重试，重试后渲染日志行", async () => {
    listResponses = [successList()];
    logResponses = [failure("SERVER_ERROR", "boom", 500), successLogs()];
    await render(createElement(TasksPanel, { agentId: "agent-1" }));

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain("任务加载失败：boom");
    expect(text()).not.toContain("ok-summary");

    await click(buttonByText("重试") as HTMLButtonElement);

    expect(logCalls).toBe(2);
    expect(text()).toContain("ok-summary");
    expect(alertRegions().length).toBe(0);
  });

  // 日志区的 401/403 与列表侧同口径：只说明原因（标题 + 提示）且不给重试——
  // 曾只渲染标题、丢掉 hint（列表侧和整页都有 hint，日志区缺），403 因此少了一半说明；
  // 断言标题 + hint 同现且无重试按钮，把该落点钉住
  test("日志区 403 单列无权限分支（标题 + 提示）且不给重试按钮", async () => {
    listResponses = [successList()];
    logResponses = [failure("UNAUTHORIZED", "forbidden", 403)];
    await render(createElement(TasksPanel, { agentId: "agent-1" }));

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain("无权访问定时任务");
    expect(text()).toContain("当前账号未被授权查看该组织的定时任务");
    // 授权失败不得退化成通用失败分支（那是给瞬时故障 + 重试准备的）
    expect(text()).not.toContain("任务加载失败：forbidden");
    expect(buttonByText("重试")).toBeUndefined();
  });
});
