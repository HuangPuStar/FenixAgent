// web/__tests__/channel-list-error-feedback.test.tsx
// AgentChannelsPage 列表失败的**反馈次数**（任务 1.3 §1.3(6) 的统一口径：同一次失败只报一次）。
//
// 为什么必须渲染而不是读源码：失败反馈有两条互斥路径——无数据时页面渲染持久错误页（role="alert" + 重试），
// 有数据时保留列表并 toast 兜底。此前 onError 无条件 toast，于是首次加载失败被报了两遍（错误页 + 弹窗）。
// 「同一失败报了几次」只有把请求真的打出去、看 toast 被调了几次才能断言。
//
// 环境：happy-dom + react-dom/client（与同批 prod-view / workflow / task 的组件用例同款）。跨包依赖只 mock
// 三处：`react-i18next`（真实库要初始化 i18n 单例）、`sonner`（toaster 订阅，且本用例要用计数替身观察反馈
// 次数），以及删除确认弹窗 `@fenix/ui-components/config/ConfirmDialog`（Radix AlertDialog 需要 portal，
// 且同进程更早的文件已用最小替身注册过它——替身自带呈现，见声明处注释）。DOM 断言范围覆盖 document.body：
// 弹窗内容与用例容器同级，按钮一律在 body 里按文案找。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = new Window({ url: "https://localhost:3000" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
// 删除确认弹窗用的是 Radix AlertDialog：它在挂载期读一批标准 DOM 全局（happy-dom 只把它们挂在
// Window 实例上，不会同步到 globalThis）。缺哪个就会在 commit 阶段抛 ReferenceError，因此按需补上；
// `getComputedStyle` 属于实例方法，必须绑定到该 Window。
for (const key of ["HTMLElement", "Element", "Node", "CustomEvent", "MutationObserver", "ResizeObserver"]) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined) g[key] = value;
}
g.getComputedStyle = win.getComputedStyle.bind(win);

/** 用例断言到的键，按 zh 字典取值；未登记的键回显自身，便于快速发现漏登记的断言目标。 */
const MOCK_TRANSLATIONS: Record<string, string> = {
  title: "通道绑定",
  newBinding: "新建绑定",
  loadBindingsFailed: "加载通道绑定失败",
  unknownError: "未知错误",
  retry: "重试",
  unauthorized: "无权访问通道绑定",
  unauthorizedHint: "当前账号未被授权管理该组织的通道绑定。",
  bindingCreated: "绑定创建成功",
  createBindingFailed: "创建绑定失败",
  bindingDeleted: "绑定已删除",
  deleteBindingFailed: "删除绑定失败",
  selectPlatformAndAgent: "请选择平台与 Agent",
  "table.searchPlaceholder": "搜索绑定...",
  "table.emptyMessage": "暂无绑定",
  "actions.delete": "删除",
  "dialog.title": "新建通道绑定",
  "dialog.platform": "平台",
  "dialog.platformPlaceholder": "如 wechat",
  "dialog.chatId": "会话 ID",
  "dialog.agent": "Agent",
  "confirm.deleteTitle": "删除绑定",
  "confirm.deleteDescription": "删除后该通道不再路由到 Agent。",
};

// 反馈计数替身：反馈「次数」是本用例的被测对象，因此 sonner 必须可观察（不是 no-op 空实现）。
const toastErrors: string[] = [];
const toastSuccesses: string[] = [];

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

/** 本文件的翻译函数：`t` 的替身与 `i18next` 替身的兜底标签共用同一份口径。 */
function translate(key: string, opts?: Record<string, unknown>): string {
  let result = MOCK_TRANSLATIONS[key] ?? key;
  for (const [name, value] of Object.entries(opts ?? {})) {
    result = result.replace(`{{${name}}}`, String(value));
  }
  return result;
}

mock.module("react-i18next", () => ({
  ...REACT_I18NEXT_UNION,
  useTranslation: () => ({ t: translate }),
}));

/**
 * `@fenix/ui-components/config/ConfirmDialog` 的同签名替身（跨文件污染的**收口点**）。
 *
 * 真实组件是 Radix AlertDialog：其呈现依赖 portal 与全局 DOM，而 `bun test packages/` 在单进程里跑完
 * 全部包，同进程更早加载的文件（skill / knowledge / workflow 的弹窗用例）已经用 `() => null` 之类的最小
 * 替身注册过这个模块——bun 1.4.2 的 `mock.module` 替换是**进程级**的，本文件页面 import 到的那份替身
 * 什么都不渲染，「确认删除」按钮永远找不到，删除路径的用例于是失败（实测：整轮只有 1 条失败，
 * 单跑本包却全绿）。反向委托给真实组件同样不可行：真实组件需要 portal 才能把内容挂到 document 上。
 * 因此替身**自带呈现**且口径与真实组件一致：`open` 为假时不渲染任何东西（删除完成后弹窗必须真的消失），
 * 打开时渲染标题、说明与取消/确认两个按钮，标签优先取调用方传入的 `confirmLabel` / `cancelLabel`，
 * 否则回落到本文件的翻译表；`loading` 时两个按钮不可点。被替换的只是 Radix 外壳，删除是否真的发起、
 * 反馈报了几次仍由页面真实逻辑决定。
 */
interface ConfirmDialogStubProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
}

mock.module("@fenix/ui-components/config/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    cancelLabel,
    onConfirm,
    loading,
  }: ConfirmDialogStubProps) =>
    open
      ? createElement(
          "div",
          { role: "alertdialog" },
          createElement("h2", null, title),
          createElement("p", null, description),
          createElement(
            "button",
            { type: "button", disabled: loading, onClick: () => onOpenChange(false) },
            cancelLabel ?? translate("confirmDialog.cancel"),
          ),
          createElement(
            "button",
            { type: "button", disabled: loading, onClick: onConfirm },
            loading ? translate("confirmDialog.processing") : (confirmLabel ?? translate("confirmDialog.confirm")),
          ),
        )
      : null,
}));

// 替身给的是跨包并集（success / error / info / warning / message）：bun 1.4.2 下 `mock.module`
// 的命名空间会被同进程后续文件复用，只给本用例用到的两个方法会让之后加载的组件取到 undefined。
mock.module("sonner", () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: (message: string) => {
      toastSuccesses.push(message);
    },
    info: () => {},
    warning: () => {},
    message: () => {},
  },
}));

afterEach(() => {
  mock.restore();
});

const { AgentChannelsPage } = await import("../pages/agent-panel/pages/AgentChannelsPage");

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

const bindingPayload = [{ id: "binding-1", platform: "wechat", chatId: "chat-1", agentId: "agent-1", enabled: true }];

let listResponses: StubResponse[] = [];
let listCalls = 0;
let deleteCalls = 0;

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
    // 环境汇总是与列表并行拉取的次要请求，用例不关心其失败路径，恒返回空列表
    if (method === "GET" && url.startsWith("/web/environments")) {
      return jsonResponse({ status: 200, body: { success: true, data: [] } });
    }
    // 删除绑定：成功是 refresh 失败场景的触发器
    if (method === "DELETE" && url.startsWith("/web/channels/bindings/")) {
      deleteCalls += 1;
      return jsonResponse({ status: 200, body: { success: true, data: null } });
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
  return { status: 200, body: { success: true, data: bindingPayload } };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  listResponses = [];
  listCalls = 0;
  deleteCalls = 0;
  toastErrors.length = 0;
  toastSuccesses.length = 0;
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

/** 在整个 document.body 里按可见文案找按钮：确认弹窗经 portal 渲染在用例容器之外。 */
function buttonByText(label: string): HTMLButtonElement | undefined {
  for (const button of win.document.body.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
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

/** 持久错误页的数量：反馈次数的断言对象是「有几个」，因此按数组返回而不是取第一个。 */
function alertRegions(): Element[] {
  return [...container.querySelectorAll('[role="alert"]')];
}

describe("AgentChannelsPage 列表失败的反馈次数", () => {
  // 首次加载失败：持久错误页已经把失败说清楚（可区分、可恢复），onError 不能再 toast——
  // 否则同一次失败被报两遍，且弹窗会盖住错误页的重试入口所在的视口。
  test("首次加载失败只落到持久错误页，反馈恰好一次且不是 toast", async () => {
    listResponses = [failure("SERVER_ERROR", "boom", 500)];
    await render(createElement(AgentChannelsPage));

    // 持久错误页 = 第 1 次反馈（恰好一次）：标题 + 原因 + 重试入口，且不退化成「暂无绑定」空态
    expect(alertRegions().length).toBe(1);
    expect(text()).toContain("加载通道绑定失败");
    expect(text()).toContain("boom");
    expect(buttonByText("重试")).toBeDefined();
    expect(text()).not.toContain("暂无绑定");

    // toast 不得追加第 2 次反馈
    expect(toastErrors).toEqual([]);
    expect(toastSuccesses).toEqual([]);
  });

  // 已有数据后刷新失败：没有持久错误页（列表被保留），此时必须 toast——否则这次刷新失败对用户不可见。
  test("已有数据后刷新失败保留列表，反馈恰好一次且是 toast", async () => {
    listResponses = [
      successList(), // 首次加载成功
      failure("SERVER_ERROR", "boom", 500), // 删除成功后的 refresh 失败
    ];
    await render(createElement(AgentChannelsPage));
    expect(text()).toContain("wechat");

    // 走删除成功 → refresh 的真实路径触发第二次列表请求
    await click(buttonByText("删除") as HTMLButtonElement);
    await click(buttonByText("confirmDialog.confirm") as HTMLButtonElement);
    expect(deleteCalls).toBe(1);
    expect(listCalls).toBe(2);

    // 第 1 次反馈：toast 告知本次刷新失败；且没有第 2 次（不渲染持久错误页）
    expect(toastErrors).toEqual(["加载通道绑定失败"]);
    expect(alertRegions().length).toBe(0);
    // 列表与删除成功的反馈都保留
    expect(text()).toContain("wechat");
    expect(text()).not.toContain("暂无绑定");
    expect(toastSuccesses).toEqual(["绑定已删除"]);
  });
});
