// web/__tests__/workflow-versions-a11y.test.tsx
// 版本行「整行点击展开 YAML」的键盘可达性与该页的失败/无权限/重试分支。
//
// 为什么是行为断言而不是 DOM 结构断言：整行加了 role/tabIndex 只说明「看起来像按钮」，真正要守的是
// 键盘按下后**真的**取了一次版本 YAML 并展开（`WorkflowVersions` 是 live 路由，键盘用户在包里没有
// 等价入口）；失败分支要守的是「有重试按钮且点了会重新请求」「无权限不给重试按钮」。
//
// 环境/mock 口径沿用 `workflow-runs-page.test.tsx`，另加 `@tanstack/react-router` 的真值替身：
// `WorkflowVersions` 用 `<Link>` 渲染编辑入口，脱离 RouterProvider 会抛错，这里只需要它渲染成一个可点的元素。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement, type FC, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

const MOCK_TRANSLATIONS: Record<string, string> = {
  "versions.loading": "加载中...",
  "versions.load_failed": "加载失败: {{error}}",
  "versions.retry": "重试",
  "versions.unauthorized_title": "无权限查看版本历史",
  "versions.unauthorized_hint": "当前账号或所属组织已无权访问该工作流，重试不会改变结果。",
  "versions.view_yaml": "查看 v{{version}} 的 YAML",
  "versions.no_versions": "暂无发布版本",
  "versions.no_versions_hint": "在编辑器中点击「发布」创建第一个版本",
  "versions.latest": "latest",
  "versions.set_latest": "设为 latest",
  "versions.restore_to_draft": "恢复到草稿",
  "versions.latest_label": "latest: {{value}}",
  "versions.latest_not_set": "未设置",
  "versions.published_count": "发布版本数: {{count}}",
  "versions.refresh": "刷新",
  "page.breadcrumb_edit": "编辑",
  "versions.title": "版本历史 — {{name}}",
  "editor.version_management": "版本管理",
  "editor.version_panel_close": "关闭版本面板",
  "editor.no_published": "未发布",
  "editor.version_total": "{{count}} 个版本",
  "editor.publish_new": "发布新版本",
  "editor.load_failed": "加载失败",
  "editor.vi_set_latest": "设为 latest",
  "editor.vi_restore_to_draft": "恢复到草稿",
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

/**
 * 稳定的 `t`：真身 `react-i18next` 的 `t` 是稳定引用（只在切语言时换身份），替身也必须如此。
 * 每次渲染新建 `t` 会让「把 `t` 写进 `useCallback` 依赖、再用该回调喂 `useEffect`」的组件
 * 在测试里陷入反复拉取（生产不复发，属替身造成的假阳性）。
 */
const MOCK_T = (key: string, opts?: Record<string, unknown>) => {
  let result = MOCK_TRANSLATIONS[key] ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      result = result.replace(`{{${k}}}`, String(v));
    }
  }
  return result;
};

/** `useTranslation` 的返回值同样是稳定对象——真身返回缓存结果，不是每次渲染新建字面量。 */
const MOCK_USE_TRANSLATION_RESULT = {
  // 真身总会返回 i18n 实例；替身少了它，组件的 locale 相关格式化（§9.3）会在渲染期抛错
  i18n: { language: "zh-CN" },
  t: MOCK_T,
};

mock.module("react-i18next", () => ({
  ...REACT_I18NEXT_UNION,
  useTranslation: () => MOCK_USE_TRANSLATION_RESULT,
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

/*
 * ConfirmDialog 替身：Radix 弹窗内容在 happy-dom 下不挂载（portal 建立、内容为空），真身无法把
 * 「行内按钮被激活」这件事暴露给断言。替身保持同签名，把 open + 标题渲染成可查询节点，于是
 * 「Enter/Space 落在按钮上」既能确认 YAML 没被展开，也能确认按钮的激活回调真的跑到了。
 * 工厂在模块求值期执行，不得引用本文件正文里的 const（TDZ）。
 */
mock.module("@fenix/ui-components/config/ConfirmDialog", () => ({
  ConfirmDialog: ({ open, title, description }: { open: boolean; title: string; description: string }) =>
    open
      ? createElement(
          "div",
          { "data-testid": "confirm-dialog" },
          createElement("span", { "data-testid": "confirm-dialog-title" }, title),
          createElement("span", { "data-testid": "confirm-dialog-description" }, description),
        )
      : null,
}));

/**
 * 路由并集替身里的 `Link`：渲染成可点的 `<a>`。
 * `params` / `search` 等参数化跳转属性不透传——本批用例只断言链接可点，不断言跳转目标。
 */
function RouterLink({ to, children, className }: { to?: string; children?: ReactNode; className?: string }) {
  return createElement("a", { href: to, className }, children);
}

/*
 * 替身给的是**跨包并集**而不是只给 `Link`：bun 1.4.2 下 `mock.module` 的命名空间在被首个 import 解析后
 * 就固定下来，而 `bun test packages/` 在单进程里跑完全部包——只给 `Link` 时，之后加载的跨包组件
 * （prod-view 的分享页要 `useParams`、model-management 要 `useNavigate`）会在链接期抛
 * `SyntaxError: Export named 'useParams' not found`。并集口径 = 全仓库 packages 内真实出现过的路由出口。
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

// ── fetch 替身：按 URL 路由，便于同时供「详情 + 版本列表 + 单个版本 YAML」三类请求 ──
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

/** 默认路由：详情成功、版本列表成功、单版本 YAML 成功。 */
function defaultRoute(url: string, method: string): MockRoute {
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

async function renderVersions(settleMs = 50): Promise<{ container: HTMLElement; root: Root }> {
  const { WorkflowVersions } = await import("../pages/workflow/WorkflowVersions");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(WorkflowVersions as FC<Record<string, unknown>>, { workflowId: "wf_1", onEditWorkflow: noop }),
    );
    await new Promise((r) => setTimeout(r, settleMs));
  });
  return { container, root };
}

/** 按 aria-label 找整行可点元素（键盘入口就是它）。 */
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

/** 派发键盘事件；React 的 onKeyDown 走冒泡，happy-dom 的 KeyboardEvent 与真实浏览器同形。 */
async function pressKey(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as KeyboardEvent);
    await new Promise((r) => setTimeout(r, 50));
  });
}

/**
 * 派发键盘事件，并在按键**未被 preventDefault** 时补一次 click（真实浏览器的按钮默认激活）。
 *
 * happy-dom 不实现 `<button>` 的键盘默认激活（实测：对按钮派发 Enter/Space 的 keydown，click 计数为 0），
 * 真实浏览器会先 preventDefault 检查再激活。不补这一步，「整行抢走后代的按键」与「按钮正常激活」在
 * 断言上无法区分：补上后，整行一旦 preventDefault，按钮回调就执行不到，回归被同时钉在两个方向。
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

/** 取确认弹窗标题（替身渲染的节点）；弹窗未打开时为 null。 */
function findConfirmDialogTitle(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="confirm-dialog-title"]')?.textContent ?? null;
}

/** 返回某次按键之后新增的 /versions/ 类请求（版本列表刷新与单版本 YAML 都算）；为空即没有触发展开/刷新。 */
function versionsCallsSince(since: number): string[] {
  return fetchCalls.slice(since).filter((call) => call.includes("/versions/"));
}

describe("WorkflowVersions 版本行键盘可达", () => {
  // Enter 必须等价于点击：取该版本 YAML 并展开（否则键盘用户无法查看版本内容）。
  test("Enter 展开版本 YAML，再按 Space 收起", async () => {
    const { container, root } = await renderVersions();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("tabindex")).toBe("0");
    expect(row?.getAttribute("aria-expanded")).toBe("false");

    await pressKey(row as HTMLElement, "Enter");

    expect(fetchCalls.some((call) => call.includes("GET /web/workflow-defs/wf_1/versions/1"))).toBe(true);
    expect(container.textContent).toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("true");

    // Space 同样是激活键（默认会滚动页面，处理器里 preventDefault）
    await pressKey(findRow(container, "查看 v1 的 YAML") as HTMLElement, " ");

    expect(container.textContent).not.toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      root.unmount();
    });
  });

  // 其它按键（如 Tab 之外的字母键）不得展开：整行是 row 而非输入控件，误触发会让键盘浏览变得不可预测。
  test("非激活键不触发展开", async () => {
    const { container, root } = await renderVersions();

    await pressKey(findRow(container, "查看 v1 的 YAML") as HTMLElement, "a");

    expect(fetchCalls.some((call) => call.includes("/versions/1"))).toBe(false);
    expect(container.textContent).not.toContain("name: demo");

    await act(async () => {
      root.unmount();
    });
  });

  // 行内操作列的按钮是整行的后代，落在它们身上的 Enter 属于按钮自身：整行不得抢走并 preventDefault，
  // 否则既会误展开 YAML，又会吞掉按钮的默认激活。两个方向都要断言——只看「没展开」会漏掉「按钮点不开」。
  test("Enter 落在行内「设为 latest」按钮上不展开 YAML，且按钮自身被激活", async () => {
    const { container, root } = await renderVersions();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    const setLatestButton = findButtonByText(row as HTMLElement, "设为 latest");
    expect(setLatestButton).not.toBeNull();

    const callsBefore = fetchCalls.length;
    await pressKeyWithActivation(setLatestButton as HTMLButtonElement, "Enter");

    expect(versionsCallsSince(callsBefore)).toEqual([]);
    expect(container.textContent).not.toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("false");
    // 按钮自身的激活回调仍然执行：确认弹窗带出的是 v1 的「设为 latest」
    expect(findConfirmDialogTitle(container)).toBe("设为 latest");

    // 守卫只排除后代：按键落在整行自身上时展开照旧
    await pressKey(findRow(container, "查看 v1 的 YAML") as HTMLElement, "Enter");
    expect(container.textContent).toContain("name: demo");

    await act(async () => {
      root.unmount();
    });
  });

  // Space 与 Enter 同为激活键、走同一段冒泡路径，必须一并守住；「恢复到草稿」是另一条按钮接线。
  test("Space 落在行内「恢复到草稿」按钮上不展开 YAML，且按钮自身被激活", async () => {
    const { container, root } = await renderVersions();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    const restoreButton = findButtonByText(row as HTMLElement, "恢复到草稿");
    expect(restoreButton).not.toBeNull();

    const callsBefore = fetchCalls.length;
    await pressKeyWithActivation(restoreButton as HTMLButtonElement, " ");

    expect(versionsCallsSince(callsBefore)).toEqual([]);
    expect(container.textContent).not.toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("false");
    expect(findConfirmDialogTitle(container)).toBe("恢复到草稿");

    await act(async () => {
      root.unmount();
    });
  });
});

describe("WorkflowVersions 失败与无权限", () => {
  // 版本列表失败：持久错误分支 + 可点重试；重试后要真的重新请求并渲染出版本行。
  test("版本列表失败提供重试并在重试后恢复", async () => {
    let versionsAttempts = 0;
    routeFor = (url, method) => {
      if (/\/versions$/.test(url)) {
        versionsAttempts += 1;
        if (versionsAttempts === 1) {
          return { status: 500, body: { success: false, error: { code: "SERVER_ERROR", message: "服务器内部错误" } } };
        }
        return { status: 200, body: okBody([VERSION_1]) };
      }
      return defaultRoute(url, method);
    };

    const { container, root } = await renderVersions();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("加载失败: 服务器内部错误");
    expect(container.textContent).not.toContain("暂无发布版本");

    const retryButton = findButtonByText(container, "重试");
    expect(retryButton).not.toBeNull();

    await act(async () => {
      (retryButton as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(versionsAttempts).toBeGreaterThanOrEqual(2);
    expect(findRow(container, "查看 v1 的 YAML")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  // 无权限（401/403 归一为 UNAUTHORIZED）：说明原因且不给重试按钮。
  test("无权限单独成态且不提供重试按钮", async () => {
    routeFor = (url, method) => {
      if (/\/versions$/.test(url))
        return { status: 403, body: { success: false, error: { message: "请求缺少组织上下文" } } };
      return defaultRoute(url, method);
    };

    const { container, root } = await renderVersions();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("无权限查看版本历史");
    expect(alert?.textContent).toContain("重试不会改变结果");
    expect(findButtonByText(container, "重试")).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});

// VersionPanel 是同一「整行点击展开 YAML」模式的第二处（编辑器右侧版本面板）。
// 面板内操作列只有「设为 latest / 恢复到草稿」，都不做展开，所以整行必须自己可聚焦。
describe("VersionPanel 版本行键盘可达", () => {
  async function renderPanel(): Promise<{ container: HTMLElement; root: Root }> {
    const { VersionPanel } = await import("../pages/workflow/components/VersionPanel");
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(VersionPanel as FC<Record<string, unknown>>, {
          workflowId: "wf_1",
          onClose: noop,
          onPublish: async () => {},
          publishing: false,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
    });
    return { container, root };
  }

  // Enter 展开该版本 YAML；关闭按钮是纯图标按钮，可访问名只能来自 aria-label（否则读屏只播报「按钮」）。
  test("Enter 展开版本 YAML，关闭按钮有可访问名", async () => {
    const { container, root } = await renderPanel();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("tabindex")).toBe("0");

    await pressKey(row as HTMLElement, "Enter");

    expect(fetchCalls.some((call) => call.includes("GET /web/workflow-defs/wf_1/versions/1"))).toBe(true);
    expect(container.textContent).toContain("name: demo");

    const closeButton = container.querySelector('button[aria-label="关闭版本面板"]');
    expect(closeButton).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  // 面板里同样是「整行 role=button 内含真实按钮」的嵌套：Enter 落在「设为 latest」上不得展开 YAML，
  // 且按钮自身仍要激活（面板内这条接线只经 ConfirmDialog 暴露，故用同签名替身观察）。
  test("Enter 落在行内「设为 latest」按钮上不展开 YAML，且按钮自身被激活", async () => {
    const { container, root } = await renderPanel();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    const setLatestButton = findButtonByText(row as HTMLElement, "设为 latest");
    expect(setLatestButton).not.toBeNull();

    const callsBefore = fetchCalls.length;
    await pressKeyWithActivation(setLatestButton as HTMLButtonElement, "Enter");

    expect(versionsCallsSince(callsBefore)).toEqual([]);
    expect(container.textContent).not.toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("false");
    expect(findConfirmDialogTitle(container)).toBe("设为 latest");

    // 守卫只排除后代：按键落在整行自身上时展开照旧
    await pressKey(findRow(container, "查看 v1 的 YAML") as HTMLElement, "Enter");
    expect(container.textContent).toContain("name: demo");

    await act(async () => {
      root.unmount();
    });
  });

  // Space 同 Enter：同为按钮激活键，后代隔离必须一并生效。
  test("Space 落在行内「恢复到草稿」按钮上不展开 YAML，且按钮自身被激活", async () => {
    const { container, root } = await renderPanel();

    const row = findRow(container, "查看 v1 的 YAML");
    expect(row).not.toBeNull();
    const restoreButton = findButtonByText(row as HTMLElement, "恢复到草稿");
    expect(restoreButton).not.toBeNull();

    const callsBefore = fetchCalls.length;
    await pressKeyWithActivation(restoreButton as HTMLButtonElement, " ");

    expect(versionsCallsSince(callsBefore)).toEqual([]);
    expect(container.textContent).not.toContain("name: demo");
    expect(findRow(container, "查看 v1 的 YAML")?.getAttribute("aria-expanded")).toBe("false");
    expect(findConfirmDialogTitle(container)).toBe("恢复到草稿");

    await act(async () => {
      root.unmount();
    });
  });
});
