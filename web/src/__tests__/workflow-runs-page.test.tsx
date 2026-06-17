import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ── 本地翻译表 ──
const MOCK_TRANSLATIONS: Record<string, string> = {
  "runs.search_placeholder": "搜索运行记录...",
  "runs.filter_all": "全部",
  "runs.status_pending": "等待中",
  "runs.status_running": "运行中",
  "runs.status_suspended": "挂起",
  "runs.status_success": "成功",
  "runs.status_failed": "失败",
  "runs.status_cancelled": "已取消",
  "runs.status_error": "错误",
  "runs.refresh": "刷新",
  "runs.load_failed": "加载失败: {{error}}",
  "runs.no_match": "没有匹配的记录",
  "runs.no_runs": "暂无运行记录",
  "runs.no_runs_filter_hint": "尝试调整筛选条件",
  "runs.no_runs_hint": "运行工作流后将在此显示记录",
  "runs.cancel": "取消",
  "runs.view_details": "查看详情",
  "runs.col_workflow": "工作流名称",
  "runs.col_status": "状态",
  "runs.col_progress": "进度",
  "runs.col_started": "开始时间",
  "runs.col_duration": "耗时",
  "runs.col_actions": "操作",
  "runs.pagination_total": "共 {{total}} 条",
  "runs.pagination_page_size": "{{size}} 条/页",
  "runs.relative_now": "刚刚",
  "runs.relative_minutes": "{{count}} 分钟前",
  "runs.relative_hours": "{{count}} 小时前",
  "runs.relative_days": "{{count}} 天前",
  "runs.total_records": "共 {{count}} 条记录",
};

// ── mock react-i18next ──
mock.module("react-i18next", () => ({
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

// ── mock sonner toast ──
mock.module("sonner", () => ({
  toast: {
    error: () => {},
    success: () => {},
  },
}));

// ── 构造 RunSummary 工厂 ──
function makeRun(overrides: Partial<import("../pages/workflow/WorkflowRuns").RunSummary> = {}) {
  return {
    run_id: "run_test_001",
    workflow_name: "测试工作流",
    workflow_id: "wf_001",
    status: "SUCCESS" as const,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    node_summary: { total: 3, completed: 3, failed: 0, running: 0 },
    ...overrides,
  };
}

// ── happy-dom 环境 ──
let win: Window;
let mockFetchResponse: { items: unknown[]; total: number; page: number; pageSize: number };
let mockFetchError: string | null = null;
let fetchCalls: Array<{ url: string; method: string }> = [];

function setupFetchMock() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, method: init?.method ?? "GET" });

    if (mockFetchError) {
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({ success: false, error: { code: "SERVER_ERROR", message: mockFetchError } }),
        text: async () => JSON.stringify({ success: false, error: { code: "SERVER_ERROR", message: mockFetchError } }),
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({
        success: true,
        data: mockFetchResponse,
      }),
      text: async () =>
        JSON.stringify({
          success: true,
          data: mockFetchResponse,
        }),
    } as unknown as Response;
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

beforeAll(() => {
  win = new Window();
  const g = globalThis as Record<string, unknown>;
  if (!g.window) g.window = win;
  if (!g.document) g.document = win.document;
  if (!g.navigator) g.navigator = win.navigator;
});

beforeEach(() => {
  fetchCalls = [];
  mockFetchError = null;
  mockFetchResponse = {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  };
});

// ── 辅助：渲染组件并等待异步状态更新 ──
async function renderAndWait(onSelectRun = mock()): Promise<{
  container: HTMLElement;
  root: Root;
  WorkflowRuns: React.FC<{ onSelectRun?: (runId: string, workflowId?: string) => void }>;
}> {
  const { WorkflowRuns } = await import("../pages/workflow/WorkflowRuns");
  const container = win.document.createElement("div");

  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(WorkflowRuns, { onSelectRun }));
    // 等待异步 effect 完成（数据加载）
    await new Promise((r) => setTimeout(r, 100));
  });

  return { container: container as unknown as HTMLElement, root, WorkflowRuns };
}

// ── 测试 ──

describe("WorkflowRuns 页面", () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    restoreFetch = setupFetchMock();
  });

  afterAll(() => {
    if (restoreFetch) restoreFetch();
  });

  // 加载时显示骨架屏
  test("加载时显示骨架屏", async () => {
    // 让 fetch 不立即 resolve，以保持 loading 状态
    let resolveFetch: (value: Response) => void;
    const pendingPromise = new Promise<Response>((r) => {
      resolveFetch = r;
    });

    globalThis.fetch = (async () => {
      return await pendingPromise;
    }) as typeof fetch;

    const { WorkflowRuns } = await import("../pages/workflow/WorkflowRuns");
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);

    act(() => {
      root.render(createElement(WorkflowRuns, { onSelectRun: mock() }));
    });

    // 初始状态 loading=true，应渲染 skeleton
    const html = container.innerHTML;
    expect(html).toContain("animate-pulse");

    // 让 fetch resolve 并清理
    (resolveFetch as unknown as (r: Response) => void)({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "application/json"]]),
      json: async () => ({ success: true, data: { items: [], total: 0, page: 1, pageSize: 20 } }),
      text: async () => JSON.stringify({ success: true, data: { items: [], total: 0, page: 1, pageSize: 20 } }),
    } as unknown as Response);

    root.unmount();
  });

  // mock 分页数据后渲染表格行
  test("mock 分页数据后渲染表格行", async () => {
    mockFetchResponse = {
      items: [
        makeRun({ run_id: "run_1", workflow_name: "数据清洗流水线", status: "SUCCESS" }),
        makeRun({ run_id: "run_2", workflow_name: "报表生成", status: "RUNNING" }),
        makeRun({ run_id: "run_3", workflow_name: "数据同步", status: "FAILED" }),
      ],
      total: 3,
      page: 1,
      pageSize: 20,
    };

    const { container, root } = await renderAndWait();

    const html = container.innerHTML;

    // 验证表格包含工作流名称
    expect(html).toContain("数据清洗流水线");
    expect(html).toContain("报表生成");
    expect(html).toContain("数据同步");

    // 验证 table 标签存在
    expect(html).toContain("<table");

    // 验证 API 调用了一次
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls[0].url).toContain("/web/workflow-runs");

    root.unmount();
  });

  // 空数据时显示空状态
  test("空数据时显示空状态", async () => {
    mockFetchResponse = {
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    };

    const { container, root } = await renderAndWait();

    const html = container.innerHTML;

    // 应显示"暂无运行记录"
    expect(html).toContain("暂无运行记录");

    root.unmount();
  });

  // 错误时显示错误提示
  test("错误时显示错误提示", async () => {
    mockFetchError = "服务器内部错误";

    const { container, root } = await renderAndWait();

    const html = container.innerHTML;

    // 应显示错误消息
    expect(html).toContain("加载失败");

    root.unmount();
  });
});
