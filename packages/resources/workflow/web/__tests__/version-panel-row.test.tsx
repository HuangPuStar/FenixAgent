// web/__tests__/version-panel-row.test.tsx
// `VersionPanel`（编辑器版本管理面板）的版本行行为：整行键盘展开 YAML、动作列与整行点击隔离、
// 破坏性动作走二次确认。
//
// 为什么守这一份：面板行原先是一份内联样式独立实现，本批起与版本页 / 版本弹层共用
// `components/VersionRow`。版本页那份已由 `workflow-versions-a11y.test.tsx` 守住（共享件落进那个
// 容器即被它覆盖），而面板这份此前零覆盖，正是「同一共享件要被第二个容器正确消费」的回归点：
// 行的键盘语义、动作列不再抢按键、确认框接线三件事在换容器后都必须仍然成立。
//
// 环境/mock 口径沿用 `workflow-versions-a11y.test.tsx`（happy-dom + 稳定 `t` + 跨包并集替身），
// 差别只在 ConfirmDialog 替身多渲染一个可点的确认按钮与 `data-variant`——确认后的请求与
// 「restore 才是 destructive」这条共享规则需要能从断言侧看见。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement, type FC } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

const MOCK_TRANSLATIONS: Record<string, string> = {
  "versions.latest": "latest",
  "versions.view_yaml": "查看 v{{version}} 的 YAML",
  "versions.set_latest": "设为 latest",
  "versions.restore_to_draft": "恢复到草稿",
  "versions.set_latest_confirm": "确定将 latest 指向 v{{version}}？",
  "versions.restore_confirm": "将 v{{version}} 的内容恢复到草稿？当前草稿将被覆盖。",
  "versions.restore_success": "已恢复到草稿",
  "versions.operation_failed": "操作失败",
  "versions.restore_failed": "恢复失败",
  "versions.yaml_load_failed": "加载失败",
  "versions.load_data_failed": "加载版本数据失败",
  "versions.no_versions_hint": "在编辑器中点击「发布」创建第一个版本",
  "editor.vi_set_latest": "设为最新",
  "editor.vi_restore_to_draft": "恢复为草稿",
  "editor.vi_restore_confirm": "将 v{{version}} 的内容恢复到草稿？当前草稿将被覆盖。",
  "editor.version_management": "版本管理",
  "editor.version_panel_close": "关闭版本面板",
  "editor.no_published": "未发布",
  "editor.version_total": "共 {{count}} 个版本",
  "editor.publish_new": "发布新版本",
  "editor.load_failed": "加载失败",
};

/** `react-i18next` 替身的跨包并集出口（口径同 `workflow-versions-a11y.test.tsx`：替身命名空间会被同进程后续文件复用）。 */
const REACT_I18NEXT_UNION = {
  I18nextProvider: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children?: unknown }) => children,
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

const MOCK_USE_TRANSLATION_RESULT = {
  i18n: { language: "zh-CN" },
  t: MOCK_T,
};

mock.module("react-i18next", () => ({
  ...REACT_I18NEXT_UNION,
  useTranslation: () => MOCK_USE_TRANSLATION_RESULT,
}));

// 跨包并集：`mock.module` 的命名空间在单进程里被后续文件复用，只给本用例用到的导出会让别的组件取到 undefined
mock.module("sonner", () => ({
  toast: {
    error: () => {},
    success: () => {},
    info: () => {},
    warning: () => {},
    message: () => {},
  },
}));

/*
 * ConfirmDialog 替身：Radix 弹窗内容在 happy-dom 下不挂载，真身无法把「确认框开了、确认后发了什么请求」
 * 暴露给断言。替身把标题 / 正文 / 变体渲染成可查询节点，并提供可点的确认按钮。工厂在模块求值期执行，
 * 不得引用本文件正文里的 const（TDZ）。
 */
mock.module("@fenix/ui-components/config/ConfirmDialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    variant,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    title: string;
    description: string;
    variant?: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open
      ? createElement(
          "div",
          { "data-testid": "confirm-dialog", "data-variant": variant ?? "default" },
          createElement("span", { "data-testid": "confirm-dialog-title" }, title),
          createElement("span", { "data-testid": "confirm-dialog-description" }, description),
          createElement(
            "button",
            {
              type: "button",
              "data-testid": "confirm-dialog-ok",
              onClick: () => {
                onConfirm();
                onOpenChange(false);
              },
            },
            "ok",
          ),
        )
      : null,
}));

afterEach(() => {
  mock.restore();
});

// ── fetch 替身：按 URL 路由，同时供「工作流详情 + 版本列表 + 单版本 YAML + 两个写操作」──
interface MockRoute {
  status: number;
  body: unknown;
}

let routeFor: (url: string, method: string) => MockRoute;
let fetchCalls: string[] = [];
let restoredFetch: typeof fetch | null = null;

function jsonResponse(spec: MockRoute): Response {
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
  restoredFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
    return jsonResponse(routeFor(url, init?.method ?? "GET"));
  }) as typeof fetch;
}

const okBody = <T,>(data: T) => ({ success: true, data });

const WORKFLOW = {
  id: "wf_1",
  userId: "u1",
  organizationId: "org1",
  name: "数据清洗流水线",
  description: null,
  latestVersion: 2,
  storagePath: null,
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

/** 默认路由：详情成功、版本列表成功、单版本 YAML 成功、两个写操作成功。 */
function defaultRoute(url: string, method: string): MockRoute {
  if (/\/versions\/\d+\/set-latest$/.test(url)) return { status: 200, body: okBody(null) };
  if (/\/versions\/\d+\/restore$/.test(url)) return { status: 200, body: okBody(null) };
  if (/\/versions\/\d+$/.test(url))
    return { status: 200, body: okBody({ workflowId: "wf_1", version: 1, yaml: "name: demo" }) };
  if (/\/versions$/.test(url)) return { status: 200, body: okBody([VERSION_1, VERSION_2]) };
  if (method === "GET") return { status: 200, body: okBody(WORKFLOW) };
  return { status: 200, body: okBody(null) };
}

beforeEach(() => {
  fetchCalls = [];
  routeFor = defaultRoute;
  setupFetchMock();
});

afterEach(() => {
  if (restoredFetch) globalThis.fetch = restoredFetch;
  restoredFetch = null;
});

const noop = () => {};
const okPublish = async () => {};

async function renderPanel(settleMs = 50): Promise<{ container: HTMLElement; root: Root }> {
  const { VersionPanel } = await import("../pages/workflow/components/VersionPanel");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(VersionPanel as FC<Record<string, unknown>>, {
        workflowId: "wf_1",
        onClose: noop,
        onPublish: okPublish,
        publishing: false,
      }),
    );
    await new Promise((r) => setTimeout(r, settleMs));
  });
  return { container, root };
}

/** 按 aria-label 找整行可点元素（版本面板的键盘入口就是它）。 */
function findRow(container: HTMLElement, label: string): HTMLElement | null {
  for (const node of container.querySelectorAll('[role="button"]')) {
    if (node.getAttribute("aria-label") === label) return node as HTMLElement;
  }
  return null;
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").includes(text)) return button as HTMLButtonElement;
  }
  return null;
}

function testId(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

/** 派发键盘事件；React 的 onKeyDown 走冒泡，happy-dom 的 KeyboardEvent 与真实浏览器同形。 */
async function pressKey(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as KeyboardEvent);
    await new Promise((r) => setTimeout(r, 50));
  });
}

/**
 * 派发键盘事件，并在按键**未被 preventDefault** 时补一次 click（真实浏览器的按钮默认激活）。
 * happy-dom 不实现 `<button>` 的键盘默认激活，不补这一步就无法区分「整行抢走后代的按键」与
 * 「按钮正常激活」——补上后，整行一旦 preventDefault，按钮回调就执行不到，回归被钉在两个方向。
 */
async function pressKeyWithActivation(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    const keydown = new win.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }) as unknown as KeyboardEvent;
    target.dispatchEvent(keydown);
    if (!keydown.defaultPrevented) {
      target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as MouseEvent);
    }
    await new Promise((r) => setTimeout(r, 50));
  });
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as MouseEvent);
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** 返回某次操作之后新增的 /versions/ 类请求（列表刷新、单版本 YAML 与两个写操作都算）。 */
function versionsCallsSince(since: number): string[] {
  return fetchCalls.slice(since).filter((call) => call.includes("/versions"));
}

describe("VersionPanel 版本行（共享 VersionRow）", () => {
  // Enter 必须等价于点击：取该版本 YAML 并展开（面板内没有别的展开入口，键盘用户否则看不到版本内容）。
  test("Enter 展开版本 YAML，再按 Enter 收起", async () => {
    const { container, root } = await renderPanel();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("tabindex")).toBe("0");
    expect(row?.getAttribute("aria-expanded")).toBe("false");

    await pressKey(row as HTMLElement, "Enter");

    expect(fetchCalls.some((call) => call.includes("GET /web/workflow-defs/wf_1/versions/1"))).toBe(true);
    expect(container.textContent).toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("true");

    await pressKey(findRow(container, "查看 v1 的 YAML") as HTMLElement, "Enter");

    expect(container.textContent).not.toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      root.unmount();
    });
  });

  // 动作列是整行的后代，落在按钮上的 Enter 属于按钮自身：整行不得抢走并 preventDefault，
  // 否则既会误展开 YAML，又会让按钮点不开。两个方向都要断言。
  test("Enter 落在「设为最新」按钮上不展开 YAML，且按钮自身被激活", async () => {
    const { container, root } = await renderPanel();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    const setLatestButton = findButtonByText(row as HTMLElement, "设为最新");
    expect(setLatestButton).not.toBeNull();

    const callsBefore = fetchCalls.length;
    await pressKeyWithActivation(setLatestButton as HTMLButtonElement, "Enter");

    expect(versionsCallsSince(callsBefore)).toEqual([]);
    expect(container.textContent).not.toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("false");
    // 按钮自身的激活回调仍然执行：确认框带出的是 v1 的「设为最新」
    expect(testId(container, "confirm-dialog-title")?.textContent).toBe("设为最新");
    expect(testId(container, "confirm-dialog")?.getAttribute("data-variant")).toBe("default");

    await act(async () => {
      root.unmount();
    });
  });

  // 确认「恢复为草稿」才发请求，且恢复是 destructive：这条规则三处共用，漂移一次就是误删草稿。
  test("确认「恢复为草稿」发出 restore 请求，变体是 destructive", async () => {
    const { container, root } = await renderPanel();

    const restoreButton = findButtonByText(container, "恢复为草稿");
    expect(restoreButton).not.toBeNull();

    await click(restoreButton as HTMLButtonElement);

    expect(testId(container, "confirm-dialog-title")?.textContent).toBe("恢复为草稿");
    expect(testId(container, "confirm-dialog-description")?.textContent).toContain("v1");
    expect(testId(container, "confirm-dialog")?.getAttribute("data-variant")).toBe("destructive");

    // 未确认前不发写请求
    expect(fetchCalls.some((call) => call.includes("restore"))).toBe(false);

    await click(testId(container, "confirm-dialog-ok") as HTMLElement);

    expect(fetchCalls.some((call) => call.includes("POST /web/workflow-defs/wf_1/versions/1/restore"))).toBe(true);
    // 确认后自动关闭，避免下次打开残留旧的待确认版本
    expect(testId(container, "confirm-dialog-title")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  // latest 药丸与「设为最新」的显隐都由 isLatest 决定：latest 行不该出现「把它自己设为 latest」。
  test("latest 行有药丸且不提供「设为最新」，其余行没有药丸", async () => {
    const { container, root } = await renderPanel();

    const latestRow = findRow(container, "查看 v2 的 YAML");
    const otherRow = findRow(container, "查看 v1 的 YAML");
    expect(latestRow?.textContent).toContain("latest");
    expect(findButtonByText(latestRow as HTMLElement, "设为最新")).toBeNull();
    expect(otherRow?.textContent).not.toContain("latest");
    expect(findButtonByText(otherRow as HTMLElement, "设为最新")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
