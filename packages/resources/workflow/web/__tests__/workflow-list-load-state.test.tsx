// web/__tests__/workflow-list-load-state.test.tsx
// WorkflowList 的加载/失败/无权限/重试数据流：请求失败必须落到**持久**错误分支并给出可点的重试入口。
//
// 为什么按状态断言而不是结构快照：这三种状态的区别只在「用户能不能自己恢复」——失败可以重试、
// 无权限重试也没用、加载中要能被读屏识别。断言 role="alert"/role="status" 与有无重试按钮，
// 正是把这条差别钉住；点击重试后要求真的再发一次请求并渲染出数据，避免按钮只是摆着好看。
//
// 环境与 mock 口径沿用 `workflow-runs-page.test.tsx`：happy-dom Window + 全局 fetch 替身 +
// react-i18next / sonner 模块替身（本包既有前端测试都是这个形状）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { OrgSessionProvider } from "@fenix/web-runtime/contexts/org-session";
import { Window } from "happy-dom";
import { act, createElement, type FC } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

// ── 本地翻译表（只列断言用到的键；其余回显 key 便于定位漏翻） ──
const MOCK_TRANSLATIONS: Record<string, string> = {
  "list.loading": "加载中...",
  "list.load_failed": "加载失败",
  "list.load_failed_hint": "请重试；若持续失败，请联系组织管理员。",
  "list.retry": "重试",
  "list.unauthorized_title": "无权限查看工作流",
  "list.unauthorized_hint": "当前账号或所属组织已无权访问工作流，重试不会改变结果。",
  "list.no_workflows": "暂无工作流",
  "list.no_workflows_hint": "点击「新建工作流」创建你的第一个工作流",
  "list.search_placeholder": "搜索工作流名称...",
  "list.delete": "删除",
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
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          result = result.replace(`{{${k}}}`, String(v));
        }
      }
      return result;
    },
  }),
}));

// 替身给的是跨包并集（success / error / info / warning / message）：bun 1.4.2 下 `mock.module`
// 的命名空间会被同进程后续文件复用，只给本用例用到的两个方法会让之后加载的组件取到 undefined。
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

// ── fetch 替身：按队列依次给出响应，便于断言「重试是否真的又发了一次请求」 ──
interface FetchResponseSpec {
  status: number;
  body: unknown;
}

let responseQueue: FetchResponseSpec[] = [];
let fetchCalls: string[] = [];
let restoredFetch: typeof fetch | null = null;

function jsonResponse(spec: FetchResponseSpec): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    statusText: "MOCK",
    headers: new Map([["content-type", "application/json"]]),
    json: async () => spec.body,
    text: async () => JSON.stringify(spec.body),
  } as unknown as Response;
}

function setupFetchMock(): void {
  const originalFetch = globalThis.fetch;
  restoredFetch = originalFetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(typeof input === "string" ? input : input.toString());
    // 队列耗尽后一直复用最后一条，避免轮询把用例拖进「无响应」状态
    const spec = responseQueue.length > 1 ? (responseQueue.shift() as FetchResponseSpec) : responseQueue[0];
    return jsonResponse(spec);
  }) as typeof fetch;
}

beforeEach(() => {
  fetchCalls = [];
  responseQueue = [{ status: 200, body: { success: true, data: [] } }];
  setupFetchMock();
});

afterEach(() => {
  if (restoredFetch) globalThis.fetch = restoredFetch;
  restoredFetch = null;
});

const noop = () => {};

interface Rendered {
  container: HTMLElement;
  root: Root;
}

/**
 * 提供组织上下文：列表是租户作用域取数，`WorkflowList` 经 `useOrgSession()` 读组织 id，
 * `ready: !!organizationId` 决定发不发请求（没有 Provider 会直接抛错）。
 * 本文件只关心加载 / 失败 / 无权限三态，故固定给一个已解析好的组织。
 */
function withOrgSession(node: unknown): ReturnType<typeof createElement> {
  return createElement(
    OrgSessionProvider as FC<{ value: unknown; children?: unknown }>,
    { value: { organizationId: "org1", userId: "u1", isOwner: true, pending: false } },
    node as never,
  );
}

/** 渲染 WorkflowList 并等待首轮请求落地（骨架屏 → 结果态）。 */
async function renderList(settleMs = 50): Promise<Rendered> {
  const { WorkflowList } = await import("../pages/workflow/WorkflowList");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      withOrgSession(
        createElement(WorkflowList as FC<Record<string, unknown>>, {
          onEditWorkflow: noop,
          onViewVersions: noop,
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, settleMs));
  });
  return { container, root };
}

/** 按可见文案找按钮；找不到返回 null（用于断言「没有重试入口」）。 */
function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").includes(text)) return button as HTMLButtonElement;
  }
  return null;
}

describe("WorkflowList 加载状态", () => {
  // 加载中必须可被读屏识别（role="status" + aria-busy），否则列表区域对辅助技术是「空白」。
  test("加载中暴露 role=status 与 aria-busy", async () => {
    // 让请求挂起：首条响应永不 resolve
    globalThis.fetch = (async () => await new Promise<Response>(() => {})) as unknown as typeof fetch;

    const { WorkflowList } = await import("../pages/workflow/WorkflowList");
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    act(() => {
      root.render(
        withOrgSession(
          createElement(WorkflowList as FC<Record<string, unknown>>, {
            onEditWorkflow: noop,
            onViewVersions: noop,
          }),
        ),
      );
    });

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.getAttribute("aria-label")).toBe("加载中...");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("WorkflowList 失败与无权限", () => {
  // 服务端故障：错误分支必须持久存在（role="alert"）并带可点的重试按钮，而不是落回「暂无工作流」空态。
  test("服务端故障渲染持久错误分支并提供重试按钮", async () => {
    responseQueue = [
      { status: 500, body: { success: false, error: { code: "SERVER_ERROR", message: "服务器内部错误" } } },
    ];

    const { container, root } = await renderList();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    // 失败块只上屏字典文案：后端信封原文（"服务器内部错误"）是服务端措辞，不该出现在界面上（§9.3）
    expect(alert?.textContent).toContain("加载失败");
    expect(alert?.textContent).not.toContain("服务器内部错误");
    // 关键区分：不是空态
    expect(container.textContent).not.toContain("暂无工作流");
    expect(findButtonByText(container, "重试")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  // 重试必须真的重新请求并渲染数据：只断言按钮存在无法发现「按钮接到错误回调」。
  test("点击重试重新请求并把数据渲染出来", async () => {
    responseQueue = [
      { status: 500, body: { success: false, error: { code: "SERVER_ERROR", message: "服务器内部错误" } } },
      {
        status: 200,
        body: {
          success: true,
          data: [
            {
              id: "wf_1",
              userId: "u1",
              organizationId: "org1",
              name: "数据清洗流水线",
              description: null,
              latestVersion: 1,
              storagePath: null,
              createdAt: "2026-09-20T00:00:00.000Z",
              updatedAt: "2026-09-20T00:00:00.000Z",
            },
          ],
        },
      },
    ];

    const { container, root } = await renderList();
    const callsBeforeRetry = fetchCalls.length;
    const retryButton = findButtonByText(container, "重试");
    expect(retryButton).not.toBeNull();

    await act(async () => {
      (retryButton as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(fetchCalls.length).toBeGreaterThan(callsBeforeRetry);
    expect(container.textContent).toContain("数据清洗流水线");
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  // 无权限（request 层把无 code 的 401/403 归一为 UNAUTHORIZED）：说明原因但不给重试按钮——
  // 重试一个被永久拒绝的请求只会让用户以为「再点点就好了」。
  test("无权限单独成态且不提供重试按钮", async () => {
    responseQueue = [{ status: 403, body: { success: false, error: { message: "请求缺少组织上下文" } } }];

    const { container, root } = await renderList();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("无权限查看工作流");
    expect(alert?.textContent).toContain("重试不会改变结果");
    expect(findButtonByText(container, "重试")).toBeNull();
    expect(container.textContent).not.toContain("暂无工作流");

    await act(async () => {
      root.unmount();
    });
  });
});
