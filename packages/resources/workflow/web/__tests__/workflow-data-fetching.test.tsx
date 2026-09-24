// web/__tests__/workflow-data-fetching.test.tsx
// 钉住「手写取数 / 手写轮询改用 `useRequest`」之后的取数契约（§3.4）：
//   ① 租户作用域轮询绑定组织：组织未解析出来时**一发不发**，组织就绪后立即取一次并按 15s 继续轮询，
//      切换组织时重查（轮询链随组织重建），旧组织在途的请求被 `AbortSignal` 取消；
//   ② 后发覆盖先发：换 workflowId / 换组织后，迟到的旧响应不得改写真在看的界面；
//   ③ 失败是持久分支（`role="alert"` + 重试），不得回落成「暂无…」空态；重试必须真的重发原请求。
//
// 取数链路走**真实 `request()`**，只桩 `globalThis.fetch`：4xx/5xx → `unwrap()` 抛 `ApiError` →
// `useRequest` 的 `error` / `onError` 整条链路都在断言范围内。若改成 mock 域模块，最易错的那条链路
// （§5.2「`request()` 对失败不 throw」）会被藏起来，测试反而会假绿。
//
// 环境/mock 口径沿用同目录的 `workflow-list-load-state.test.tsx`（happy-dom + 跨包并集替身）。
// 轮询用例用 `bun:test` 的假定时器推进 15s —— 这是唯一能在用例里观察到「轮询真的在跑」的办法；
// 假定时器下不能再用 `setTimeout` 排空队列，改用 `flushMicrotasks()`。

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { OrgSessionProvider } from "@fenix/web-runtime/contexts/org-session";
import { Window } from "happy-dom";
import { act, createContext, createElement, type FC, type ReactElement, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

/*
 * Popover 替身：radix 的 portal 内容在 happy-dom 下不挂载（§11.2 实测），弹层内的失败块与重试按钮
 * 因此永远查不到。替身把「点击 trigger → 内容就地渲染」这条状态机按真实语义重写一遍，只服务于
 * `VersionIndicator` 的断言；真身「点触发按钮开关弹层」不属本次改造对象，也不在断言范围。
 * 工厂在模块求值期执行，不得引用本文件正文里的 const（TDZ）。
 */
mock.module("@fenix/ui-components/ui/popover", () => {
  const StubPopoverContext = createContext<{ open: boolean; setOpen: (next: boolean) => void } | null>(null);
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange?: (next: boolean) => void;
      children?: unknown;
    }) =>
      createElement(
        StubPopoverContext.Provider,
        { value: { open, setOpen: (next: boolean) => onOpenChange?.(next) } },
        children as never,
      ),
    PopoverTrigger: ({ children }: { children?: unknown }) => {
      const ctx = useContext(StubPopoverContext);
      return createElement(
        "span",
        { "data-testid": "popover-trigger", onClick: () => ctx?.setOpen(true) },
        children as never,
      );
    },
    PopoverContent: ({ children }: { children?: unknown }) => {
      const ctx = useContext(StubPopoverContext);
      return ctx?.open ? createElement("div", { "data-testid": "popover-content" }, children as never) : null;
    },
  };
});

// ── 本地翻译表（只列断言用到的键；其余回显 key，便于定位漏翻） ──
const MOCK_TRANSLATIONS: Record<string, string> = {
  "list.loading": "加载中...",
  "list.no_workflows": "暂无工作流",
  "list.retry": "重试",
  "editor.trigger_title": "Webhook 触发器",
  "editor.trigger_empty": "暂无 Webhook 触发器",
  "editor.trigger_load_failed": "加载触发器失败",
  "editor.trigger_retry": "重试",
  "editor.version_management": "版本管理",
  "editor.no_published": "未发布",
  "editor.vi_no_versions": "暂无发布版本",
  "editor.tooltip_version_indicator": "版本",
  "versions.latest": "最新版本",
  "versions.load_data_failed": "加载版本数据失败",
  "versions.retry": "重试",
  "versions.view_yaml": "查看 v{{version}} 的 YAML",
  "versions.no_versions_hint": "在编辑器中点击「发布」创建第一个版本",
  "editor.version_panel_close": "关闭版本面板",
  "editor.vi_set_latest": "设为最新",
  "editor.vi_restore_to_draft": "恢复为草稿",
  "editor.vi_badge_draft": "草稿",
  "editor.vi_status_draft": "当前是草稿",
};

/** 稳定的 `t`：真身在切语言之外身份不变，替身每次渲染新建会让依赖它的 effect 反复拉取。 */
const MOCK_T = (key: string, opts?: Record<string, unknown>) => {
  let result = MOCK_TRANSLATIONS[key] ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      result = result.replace(`{{${k}}}`, String(v));
    }
  }
  return result;
};

/** `react-i18next` 替身的跨包并集出口（口径见 `workflow-list-load-state.test.tsx`）。 */
const REACT_I18NEXT_UNION = {
  I18nextProvider: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children?: unknown }) => children,
};

mock.module("react-i18next", () => ({
  ...REACT_I18NEXT_UNION,
  useTranslation: () => ({ t: MOCK_T, i18n: { language: "zh-CN" } }),
}));

// 替身给的是跨包并集：bun 1.4.2 下 `mock.module` 的命名空间会被同进程后续文件复用。
mock.module("sonner", () => ({
  toast: {
    error: () => {},
    success: () => {},
    info: () => {},
    warning: () => {},
    message: () => {},
  },
}));

afterEach(() => {
  mock.restore();
});

// ── fetch 替身：请求入队后由用例决定何时、以什么结果回应 ──
interface PendingRequest {
  url: string;
  resolve: (response: Response) => void;
}

let pending: PendingRequest[] = [];
/** 累计发出的请求 URL（`pending` 只表示「此刻还在途」）。 */
let requestUrls: string[] = [];
/** 被取消的请求 URL：租户 / 工作流切换时必须能观察到旧连接被主动断开。 */
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

/** 列表 / 版本的统一信封。 */
const ok = <T,>(data: T) => jsonResponse({ success: true, data });
const fail = (message: string, status = 500) =>
  jsonResponse({ success: false, error: { code: "SERVER_ERROR", message } }, status);

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
        // 真实 fetch 被 abort 之后不会再收到响应：把它移出在途队列，后续的 `respond` 只会命中真正在途的那笔
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
}

/** 回应某条在途请求（按 URL 子串定位），并把它移出队列。 */
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
  jest.useRealTimers();
});

/** 排空微任务队列（假定时器下不能靠 `setTimeout` 排空；React 的更新在同一批微任务里落地）。 */
async function flushMicrotasks(times = 16): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  });
}

interface OrgSessionValue {
  organizationId: string | null;
  userId: string | null;
  isOwner: boolean;
  pending: boolean;
}

const ORG_1: OrgSessionValue = { organizationId: "org1", userId: "u1", isOwner: true, pending: false };

/** 给需要组织上下文的组件套上 `OrgSessionProvider`（生产里由身份的 `OrgProvider` 投影）。 */
function withOrgSession(node: ReactElement, value: OrgSessionValue): ReactElement {
  return createElement(OrgSessionProvider as FC<{ value: OrgSessionValue; children?: unknown }>, { value }, node);
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

/** 按可见文案找按钮；找不到返回 null（用于断言「没有重试入口」）。 */
function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").includes(text)) return button as HTMLButtonElement;
  }
  return null;
}

/** 按 aria-label 找可点元素（版本行 / 触发器行的键盘入口就是它）。 */
function findByLabel(container: HTMLElement, label: string): HTMLElement | null {
  for (const node of container.querySelectorAll('[role="button"]')) {
    if (node.getAttribute("aria-label") === label) return node as HTMLElement;
  }
  return null;
}

const WORKFLOW_ORG_1 = {
  id: "wf_1",
  userId: "u1",
  organizationId: "org1",
  name: "org1 的数据清洗流水线",
  description: null,
  latestVersion: 1,
  storagePath: null,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

const WORKFLOW_ORG_2 = { ...WORKFLOW_ORG_1, id: "wf_2", organizationId: "org2", name: "org2 的数据清洗流水线" };

const TRIGGER_1 = {
  id: "tr_1",
  workflowId: "wf_1",
  type: "webhook",
  publicHash: "pub_1",
  maskedHash: "****1",
  webhookUrl: "https://example.test/hook/1",
  secret: null,
  config: null,
  enabled: true,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

const VERSION_1 = {
  id: "ver_1",
  workflowId: "wf_1",
  version: 1,
  filePath: "v1.yaml",
  status: "active",
  createdBy: "u1",
  createdAt: "2026-09-19T00:00:00.000Z",
};

const VERSION_2 = { ...VERSION_1, id: "ver_2", version: 2, filePath: "v2.yaml" };

describe("WorkflowList 的租户作用域轮询", () => {
  // 组织未解析出来时不得发请求（`ready: !!organizationId`）：此时还不知道该取哪个组织的数据，
  // 抢先请求只会拿到被服务端拒绝的结果或别的组织的数据。组织一旦就绪必须立即补一次。
  test("无组织 id 不发请求，组织就绪后立即取数", async () => {
    const { WorkflowList } = await import("../pages/workflow/WorkflowList");
    const listNode = createElement(WorkflowList as FC<Record<string, unknown>>, {
      onEditWorkflow: () => {},
      onViewVersions: () => {},
    });

    const container = render(
      withOrgSession(listNode, { organizationId: null, userId: "u1", isOwner: true, pending: false }),
    );
    await flushMicrotasks();
    expect(requestUrls).toEqual([]);

    rerender(withOrgSession(listNode, ORG_1));
    await flushMicrotasks();
    expect(requestUrls.length).toBe(1);
    expect(requestUrls[0]).toContain("/web/workflow-defs");

    respond("/web/workflow-defs", ok([WORKFLOW_ORG_1]));
    await flushMicrotasks();
    expect(container.textContent).toContain("org1 的数据清洗流水线");
  });

  // 轮询必须真的在跑，且每次都发一条请求（改造前每 tick 发两条：先取一次并丢弃结果，再 `refresh()` 重取）。
  test("组织就绪后每 15s 轮询一次列表", async () => {
    jest.useFakeTimers();
    const { WorkflowList } = await import("../pages/workflow/WorkflowList");
    render(
      withOrgSession(
        createElement(WorkflowList as FC<Record<string, unknown>>, {
          onEditWorkflow: () => {},
          onViewVersions: () => {},
        }),
        ORG_1,
      ),
    );
    await flushMicrotasks();
    expect(requestUrls.length).toBe(1);
    respond("/web/workflow-defs", ok([WORKFLOW_ORG_1]));
    await flushMicrotasks();

    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await flushMicrotasks();
    expect(requestUrls.length).toBe(2);
    respond("/web/workflow-defs", ok([WORKFLOW_ORG_1]));
    await flushMicrotasks();

    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await flushMicrotasks();
    expect(requestUrls.length).toBe(3);
  });

  // 切组织 = 轮询链随组织重建：旧的轮询不再代表「当前组织」，必须在 `refreshDeps` 变化时重发，
  // 且旧组织在途的那一笔要被 `AbortSignal` 真正取消（而不是等它跑完再丢弃结果）。
  test("切组织时重查列表并取消旧组织的在途请求", async () => {
    const { WorkflowList } = await import("../pages/workflow/WorkflowList");
    const listNode = createElement(WorkflowList as FC<Record<string, unknown>>, {
      onEditWorkflow: () => {},
      onViewVersions: () => {},
    });

    const container = render(withOrgSession(listNode, ORG_1));
    await flushMicrotasks();
    expect(requestUrls.length).toBe(1);

    // 旧组织的请求仍在途时切到 org2
    rerender(withOrgSession(listNode, { ...ORG_1, organizationId: "org2" }));
    await flushMicrotasks();
    expect(requestUrls.length).toBe(2);
    expect(abortedUrls.length).toBe(1);
    expect(abortedUrls[0]).toContain("/web/workflow-defs");

    // 旧响应即便迟到也不能改写在看的界面（此刻在途的只剩 org2 那一笔）
    respond("/web/workflow-defs", ok([WORKFLOW_ORG_2]));
    await flushMicrotasks();
    expect(container.textContent).toContain("org2 的数据清洗流水线");
    expect(container.textContent).not.toContain("org1 的数据清洗流水线");
  });
});

describe("TriggerPanel 的失败态与竞态", () => {
  async function renderTriggerPanel(workflowId: string): Promise<HTMLElement> {
    const { TriggerPanel } = await import("../pages/workflow/components/TriggerPanel");
    const container = render(
      createElement(TriggerPanel as FC<Record<string, unknown>>, { workflowId, onClose: () => {} }),
    );
    await flushMicrotasks();
    return container;
  }

  // 取数失败是授权 / 服务故障，不是「没有触发器」：必须渲染可重试的持久失败块，重试后真的重发并渲染数据。
  test("失败渲染持久失败块，重试重发并渲染触发器", async () => {
    const container = await renderTriggerPanel("wf_1");
    expect(requestUrls[0]).toContain("/web/workflow-defs/wf_1/triggers");

    respond("/triggers", fail("触发器服务不可用", 503));
    await flushMicrotasks();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("加载触发器失败");
    // 关键区分：失败不是空态
    expect(container.textContent).not.toContain("暂无 Webhook 触发器");

    const retry = findButtonByText(container, "重试");
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    await flushMicrotasks();
    expect(requestUrls.length).toBe(2);

    respond("/triggers", ok([TRIGGER_1]));
    await flushMicrotasks();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("https://example.test/hook/1");
  });

  // 换 workflowId 时后发覆盖先发：旧工作流的在途请求要被取消，迟到的旧结果不得挂在新工作流的面板上。
  test("换 workflowId 时取消先发请求，后发结果胜出", async () => {
    const container = await renderTriggerPanel("wf_1");
    expect(requestUrls[0]).toContain("/web/workflow-defs/wf_1/triggers");

    // 旧工作流请求仍在途时切到 wf_2
    rerender(
      createElement(
        (await import("../pages/workflow/components/TriggerPanel")).TriggerPanel as FC<Record<string, unknown>>,
        { workflowId: "wf_2", onClose: () => {} },
      ),
    );
    await flushMicrotasks();
    expect(requestUrls.length).toBe(2);
    expect(requestUrls[1]).toContain("/web/workflow-defs/wf_2/triggers");
    expect(abortedUrls.length).toBe(1);

    respond("/wf_2/triggers", ok([{ ...TRIGGER_1, id: "tr_2", workflowId: "wf_2", webhookUrl: "https://wf2.test" }]));
    await flushMicrotasks();

    // 旧工作流那一笔已经被取消、也不在在途队列里（真实 fetch 被 abort 后不会再收到响应）：
    // 后发结果因此不可能被先发覆盖。
    expect(pending.some((item) => item.url.includes("/wf_1/triggers"))).toBe(false);
    expect(container.textContent).toContain("https://wf2.test");
    expect(container.textContent).not.toContain("https://example.test/hook/1");
  });
});

describe("VersionPanel 的失败态", () => {
  async function renderVersionPanel(): Promise<HTMLElement> {
    const { VersionPanel } = await import("../pages/workflow/components/VersionPanel");
    const container = render(
      createElement(VersionPanel as FC<Record<string, unknown>>, {
        workflowId: "wf_1",
        onClose: () => {},
        onPublish: async () => {},
        publishing: false,
      }),
    );
    await flushMicrotasks();
    return container;
  }

  // 版本列表失败必须落持久失败块（而不是「暂无发布版本」空态），重试重发后渲染真实版本行。
  test("版本列表失败渲染失败块，重试后渲染版本行", async () => {
    const container = await renderVersionPanel();
    expect(requestUrls.some((url) => url.endsWith("/wf_1/versions"))).toBe(true);
    expect(requestUrls.some((url) => url.endsWith("/wf_1"))).toBe(true);

    respond("/wf_1/versions", fail("版本服务不可用", 500));
    respond("/wf_1", ok(WORKFLOW_ORG_1));
    await flushMicrotasks();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("加载版本数据失败");
    expect(container.textContent).not.toContain("暂无发布版本");

    const retry = findButtonByText(container, "重试");
    act(() => retry?.click());
    await flushMicrotasks();
    respond("/wf_1/versions", ok([VERSION_1, VERSION_2]));
    await flushMicrotasks();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(findByLabel(container, "查看 v2 的 YAML")).not.toBeNull();
  });

  // 详情与版本列表各自取数（改造前用 `Promise.allSettled` 刻意让「某一项失败不影响另一项」）：
  // 详情失败时版本列表仍要正常渲染，合并成一份 `useRequest` 会把这条语义丢掉。
  test("详情失败不影响版本列表的渲染", async () => {
    const container = await renderVersionPanel();

    respond("/wf_1", fail("详情服务不可用", 500));
    respond("/wf_1/versions", ok([VERSION_1, VERSION_2]));
    await flushMicrotasks();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(findByLabel(container, "查看 v1 的 YAML")).not.toBeNull();
    expect(findByLabel(container, "查看 v2 的 YAML")).not.toBeNull();
    // 头部那一行依赖详情数据，详情失败时整行不渲染（与改造前 `wf` 为 null 时一致）
    expect(container.textContent).toContain("版本管理");
  });
});

describe("VersionIndicator 的取数门禁与失败态", () => {
  async function renderVersionIndicator(): Promise<HTMLElement> {
    const { VersionIndicator } = await import("../pages/workflow/components/VersionIndicator");
    const container = render(
      createElement(VersionIndicator as FC<Record<string, unknown>>, {
        workflowId: "wf_1",
        latestVersion: 1,
        previewVersion: null,
        onPreview: () => {},
        onBackToDraft: () => {},
        onViewAll: () => {},
      }),
    );
    await flushMicrotasks();
    return container;
  }

  /** 点触发按钮打开弹层（替身据此把内容就地渲染出来）。 */
  function openPopover(container: HTMLElement): void {
    const trigger = container.querySelector('[data-testid="popover-trigger"]') as HTMLElement | null;
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
  }

  // 弹层没打开就不该取数（改造前是 `if (open) loadVersions()`）：关着的时候取一次纯属浪费，
  // 打开时才取——`ready: !!workflowId && open` 必须保住这条语义。
  test("弹层未打开不取数，打开后才请求版本列表", async () => {
    const container = await renderVersionIndicator();
    expect(requestUrls).toEqual([]);

    openPopover(container);
    await flushMicrotasks();
    expect(requestUrls.length).toBe(1);
    expect(requestUrls[0]).toContain("/web/workflow-defs/wf_1/versions");
  });

  // 取数失败必须是可重试的持久失败块，而不是「暂无发布版本」空态：弹层里的这句话就是用户唯一能看到的解释。
  test("版本列表失败渲染失败块，重试重发并渲染版本行", async () => {
    const container = await renderVersionIndicator();
    openPopover(container);
    await flushMicrotasks();

    respond("/wf_1/versions", fail("版本服务不可用", 500));
    await flushMicrotasks();

    const alert = container.querySelector('[data-testid="popover-content"] [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("加载版本数据失败");
    expect(container.textContent).not.toContain("暂无发布版本");

    const retry = findButtonByText(container, "重试");
    act(() => retry?.click());
    await flushMicrotasks();
    expect(requestUrls.length).toBe(2);

    respond("/wf_1/versions", ok([VERSION_1]));
    await flushMicrotasks();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // 弹层里的版本行（弹层形态不给 `expand`，故按渲染出来的版本号断言，而不是整行的可访问名）
    expect(container.querySelector('[data-testid="popover-content"]')?.textContent).toContain("v1");
  });
});
