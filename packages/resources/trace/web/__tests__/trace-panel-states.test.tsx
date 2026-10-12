// web/__tests__/trace-panel-states.test.tsx
// Trace 面板「取数状态与选中派生」的关键交互用例（前端规范的统一口径）：四种事实不得互相冒充——
// 「部署没接观测后端」「这个会话还没建 ACP 会话」「这个会话没有 run」「读取失败」各自有独立界面与出口。
//
// 为什么用真实渲染而不是读源码断言：被钉住的行为是「未配置不显示成空态」「失败态给得出重试且重试真的重发」
// 「有 run 时默认选中最新一条并按它取图」——这三条都取决于 `useRequest` 的状态流转、分支顺序与派生的
// `activeTraceId`。源码里出现 `configured` 字样不等于运行时走到了那个分支（后端给了字段、界面却没消费，
// 正是这类事故的典型形态）。
//
// 环境：happy-dom + react-dom/client（与本仓库 task / prod-view 的组件用例同款）。只 mock 一处外部依赖：
// `fetch`（唯一数据源，替身按路径分派，保持 `request` / `unwrap` 的真实解析路径）。**不 mock
// `react-i18next`**：用真实库 + 本包自己的字典（`traceResources`，由 `web/i18n/index.ts` 导出），断言直接
// 落在用户可见的中文文案上——mock 掉 i18n 只能证明「某个键被渲染」，而且 `mock.module` 在同进程内会影响
// 之后加载的用例（`packages/resources/memory/web/__tests__/memory-graph-i18n.test.ts` 就依赖真实
// `react-i18next`），这个代价不值得付。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance, type i18n as I18n } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { TracePanel } from "../components/TracePanel";
import { traceResources } from "../i18n";
import { TRACE_NS } from "../i18n/namespace";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator。 */
const win = new Window({ url: "https://localhost:3000" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

const ENVIRONMENT_ID = "env-1";
const INSTANCE_UID = "instance-uid-1";

interface FetchCall {
  url: string;
}

/**
 * 桩响应：只需要给 `Response`——`unwrap` 读的是响应体里的信封，HTTP 状态码由用例的表达力承担
 * （503 与 200+`success:false` 在取数基建里走同一条失败路径）。
 */
type StubResponse = { body: Response };

/** fetch 替身：按路径分派到本用例预置的响应，保持 `request` / `unwrap` 的真实解析路径。 */
let calls: FetchCall[] = [];
let listResponse: () => StubResponse = () => ok(listBody({ configured: false }));
let observationsResponse: () => StubResponse = () => ok({ data: [], cursor: null });

function ok(data: unknown): StubResponse {
  return { body: json({ success: true, data }) };
}
function failure(): StubResponse {
  return { body: json({ success: false, error: { code: "TRACE_BACKEND_UNREACHABLE", message: "观测后端不可达" } }) };
}
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

/** 列表响应体：默认未配置，用例按需覆盖。 */
function listBody(overrides: Record<string, unknown>) {
  return { configured: true, acpSessionId: "acp-session-1", traces: [], page: 1, totalItems: 0, ...overrides };
}
function run(id: string, timestamp: string) {
  return {
    id,
    name: `turn ${id}`,
    timestamp,
    sessionId: "acp-session-1",
    userId: "user-1",
    version: null,
    release: null,
    environment: "default",
    bookmarked: false,
    tags: [],
  };
}

const traceId = (url: string) => url.match(/\/traces\/([^/]+)\/observations/)?.[1] ?? null;

/** 最近一次 observations 请求带的 traceId（图取数是否跟着生效的 run 走）。 */
function lastObservationTraceId(): string | null {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const id = traceId(calls[index].url);
    if (id) return id;
  }
  return null;
}

/** 用例断言用的真实文案（本包 zh 字典，不另抄一份到测试里）。 */
const TEXT = {
  notConfigured: traceResources.zh.list.notConfiguredTitle,
  noSession: traceResources.zh.list.noSessionTitle,
  empty: traceResources.zh.list.empty,
  listFailed: traceResources.zh.list.loadFailed,
  retry: traceResources.zh.list.retry,
  graphFailed: traceResources.zh.panel.graphLoadFailed,
  graphEmpty: traceResources.zh.panel.graphEmpty,
};

/**
 * 失败用例会经 hooks 的 onError（warn）与取数基建的失败日志（error）打屏：静音它们，避免测试输出被预期间谍
 * 污染（同仓库 knowledge / skill 的失败态用例同款）。
 */
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
/**
 * 原始 fetch：用例收尾必须还原它——同进程内别的用例（如 `langfuse-client.test.ts` 的 `Bun.serve` 真服务）
 * 依赖全局 fetch，留下替身会让它们以「连不上上游」的形式失败。
 */
const originalFetch = globalThis.fetch;

let translations: I18n;
let mountedRoot: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(async () => {
  calls = [];
  console.warn = () => {};
  console.error = () => {};
  listResponse = () => ok(listBody({ configured: false }));
  observationsResponse = () => ok({ data: [], cursor: null });
  g.fetch = (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    const response = url.includes("/observations") ? observationsResponse() : listResponse();
    return Promise.resolve(response.body);
  };
  translations = createInstance();
  await translations.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "en",
    ns: [TRACE_NS],
    resources: { en: { [TRACE_NS]: traceResources.en }, zh: { [TRACE_NS]: traceResources.zh } },
  });
});

afterEach(() => {
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  g.fetch = originalFetch;
  if (mountedRoot && container) {
    act(() => mountedRoot?.unmount());
    container.remove();
  }
  mountedRoot = null;
  container = null;
});

/** 挂载面板并等待取数落地（ahooks 的异步链要跨多个微任务/宏任务）。 */
async function renderPanel(): Promise<string> {
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例（prod-view / workflow）的做法一次性收窄
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(
      createElement(
        I18nextProvider,
        { i18n: translations },
        createElement(TracePanel, { environmentId: ENVIRONMENT_ID, sessionId: INSTANCE_UID }),
      ) as ReactElement,
    );
  });
  await flush();
  return container.textContent ?? "";
}

async function flush() {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(): string {
  return container?.textContent ?? "";
}

/** 按可见文案定位按钮（面板的重试 / 刷新出口都是按钮）。 */
function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find((node) => node.textContent?.includes(label));
  if (!found) throw new Error(`找不到按钮：${label}（当前文案：${text()}）`);
  return found as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await flush();
}

describe("Trace 面板取数状态", () => {
  // 部署没接观测后端是配置事实，不是「这个会话没有 run」：必须给出配置引导。
  test("未配置观测读取时显示配置引导，而不是空态", async () => {
    const rendered = await renderPanel();
    expect(rendered).toContain(TEXT.notConfigured);
    expect(rendered).not.toContain(TEXT.empty);
    expect(rendered).not.toContain(TEXT.noSession);
  });

  // 已配置但尚未 session/new：同样不是空态，文案必须与上面两条都不同。
  test("无活跃 ACP 会话时显示会话引导，而不是空态", async () => {
    listResponse = () => ok(listBody({ acpSessionId: null }));
    const rendered = await renderPanel();
    expect(rendered).toContain(TEXT.noSession);
    expect(rendered).not.toContain(TEXT.notConfigured);
    expect(rendered).not.toContain(TEXT.empty);
  });

  // 会话已建立但没有 run：这才是空态；同时不得显示任何失败文案。
  test("会话内没有 run 时显示空态", async () => {
    listResponse = () => ok(listBody({}));
    const rendered = await renderPanel();
    expect(rendered).toContain(TEXT.empty);
    expect(rendered).not.toContain(TEXT.listFailed);
  });

  // 失败必须显式成失败并给出重试出口；点重试要真的重发请求（而不是只切 UI 状态）。
  test("列表加载失败时可重试，重试后恢复到正常态", async () => {
    let attempt = 0;
    listResponse = () => {
      attempt += 1;
      if (attempt === 1) return failure();
      return ok(listBody({ traces: [run("trace-new", "2026-10-02T00:00:00.000Z")], totalItems: 1 }));
    };
    const rendered = await renderPanel();
    expect(rendered).toContain(TEXT.listFailed);
    const before = calls.length;

    await click(TEXT.retry);

    expect(calls.length).toBeGreaterThan(before);
    expect(text()).not.toContain(TEXT.listFailed);
    expect(lastObservationTraceId()).toBe("trace-new");
  });

  // 图取数跟着「生效的 run」走：列表倒序后默认选中最新一条，observations 必须按它的 id 请求。
  test("有 run 时默认选中最新一条并按它取图", async () => {
    listResponse = () =>
      ok(
        listBody({
          traces: [run("trace-old", "2026-10-01T00:00:00.000Z"), run("trace-new", "2026-10-02T00:00:00.000Z")],
          totalItems: 2,
        }),
      );
    await renderPanel();
    expect(lastObservationTraceId()).toBe("trace-new");
  });

  // 图读取失败有自己的失败态与重试出口，不得退化成「这条 run 没有可绘制的节点」（空态与失败是两件事）。
  test("调用图加载失败时显示失败态而不是空态", async () => {
    listResponse = () => ok(listBody({ traces: [run("trace-1", "2026-10-01T00:00:00.000Z")], totalItems: 1 }));
    observationsResponse = () => failure();
    const rendered = await renderPanel();
    expect(rendered).toContain(TEXT.graphFailed);
    expect(rendered).not.toContain(TEXT.graphEmpty);
  });
});
