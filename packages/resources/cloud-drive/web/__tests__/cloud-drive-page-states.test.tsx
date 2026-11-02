// web/__tests__/cloud-drive-page-states.test.tsx
// 云盘页面的状态与重试接线：加载骨架 → 空目录；列表失败 → `role="alert"` + 重试真的重新请求；
// 回收站切过去才取数、空回收站给空态。
//
// 这几条只有运行时才能证明：读源码无法确认「重试按钮绑定的是 refresh」或「trash 不在初始视图发请求」。
// 环境：happy-dom + react-dom/client（与同批 knowledge / prod-view 的组件用例同款）。
//
// 不 mock 模块：数据源只有 `globalThis.fetch` 一处，页面经统一的 `request()` 访问它；i18n 用真实
// i18next 实例并挂本包与 ui-components 两份字典（对话框的按钮文案来自后者）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { CLOUD_DRIVE_NS, cloudDriveResources } from "../i18n";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator。
const win = new Window({ url: "https://localhost:3000" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
const DOM_GLOBALS = [
  "HTMLElement",
  "HTMLDivElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "SVGElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "ShadowRoot",
  "DOMRect",
  "DOMTokenList",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "InputEvent",
  "MutationObserver",
  "ResizeObserver",
  "customElements",
];
for (const key of DOM_GLOBALS) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined) g[key] = value;
}
g.getComputedStyle = win.getComputedStyle.bind(win);

const { CloudDrivePage } = await import("../pages/cloud-drive-page");

const TEXT = cloudDriveResources.en;

/** 渲染用真实 i18next 实例：本包字典 + ui-components（FormDialog / ConfirmDialog 的默认按钮文案）。 */
const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: CLOUD_DRIVE_NS,
  initAsync: false,
  resources: {
    en: { [CLOUD_DRIVE_NS]: cloudDriveResources.en, [UI_COMPONENTS_NS]: uiComponentsResources.en },
  },
});

function withI18n(node: ReactElement): ReactElement {
  return createElement(I18nextProvider, { i18n }, node);
}

type StubResponse = { status: number; body: unknown };

const ME_URL = "/web/cloud-drive/me";
const FILES_URL = "/web/cloud-drive/files";
const TRASH_URL = "/web/cloud-drive/trash";
const SEARCH_URL = "/web/cloud-drive/search";

const ME_SUCCESS: StubResponse = {
  status: 200,
  body: {
    success: true,
    data: {
      subject: "user-1",
      quota: { limitBytes: 1024, usedBytes: 256, reservedBytes: 0, updatedAt: null },
    },
  },
};

/** 后端非 2xx 错误信封；`request()` 会把它转成 `ApiError(message, code)`。 */
function failure(code: string, message: string, status = 500): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

function fileItem(name: string, kind: "file" | "directory" = "file") {
  return {
    id: `file-${name}`,
    parentId: null,
    name,
    path: `/${name}`,
    kind,
    lifecycle: "active",
    sizeBytes: kind === "file" ? 1024 : 0,
    contentType: kind === "file" ? "text/plain" : "application/octet-stream",
    currentVersionId: kind === "file" ? "version-1" : null,
    metadataRevision: 1,
    createdAt: null,
    updatedAt: "2026-10-28T10:00:00Z",
    conversion: null,
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

let listResponses: StubResponse[] = [];
let listCalls = 0;
let trashCalls = 0;
let searchCalls = 0;
let searchResponse: StubResponse = {
  status: 200,
  body: { success: true, data: { items: [], nextCursor: null, fileCount: 0, matchCount: 0 } },
};
let restoreFetch: () => void;
let restoreConsoleError: () => void;
const consoleErrorCalls: unknown[][] = [];

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url === ME_URL) return jsonResponse(ME_SUCCESS);
    if (method === "GET" && (url === FILES_URL || url.startsWith(`${FILES_URL}?`))) {
      listCalls += 1;
      const next = listResponses[Math.min(listCalls - 1, listResponses.length - 1)];
      return jsonResponse(next);
    }
    if (method === "GET" && url === TRASH_URL) {
      trashCalls += 1;
      return jsonResponse({ status: 200, body: { success: true, data: { items: [] } } });
    }
    if (method === "POST" && url === SEARCH_URL) {
      searchCalls += 1;
      return jsonResponse(searchResponse);
    }
    throw new Error(`用例未登记的请求：${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  listResponses = [];
  listCalls = 0;
  trashCalls = 0;
  searchCalls = 0;
  searchResponse = {
    status: 200,
    body: { success: true, data: { items: [], nextCursor: null, fileCount: 0, matchCount: 0 } },
  };
  consoleErrorCalls.length = 0;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
  restoreConsoleError = () => {
    console.error = originalConsoleError;
  };
  restoreFetch = stubFetch();
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
  restoreConsoleError();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 只挂载、不等待请求落定：用于观察首帧的加载骨架。 */
function mount(): void {
  act(() => {
    root.render(withI18n(createElement(CloudDrivePage)));
  });
}

async function render(): Promise<void> {
  mount();
  await settle();
}

function text(): string {
  return container.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
  }
  return;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await settle();
}

const EMPTY_PAGE: StubResponse = {
  status: 200,
  body: { success: true, data: { items: [], nextCursor: null } },
};

describe("云盘页面的加载 / 空 / 失败状态", () => {
  // 业务意图：列表请求未落定时必须给出可感知的加载态，而不是空白页；落定为 0 条时给可操作的空态。
  test("首帧显示加载态，空目录显示空态与上传入口", async () => {
    listResponses = [EMPTY_PAGE];
    // 用未落定的 Promise 观察首帧：resolve 之前页面必须处于 loading。
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && String(input).startsWith(FILES_URL)) {
        await gate;
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    mount();
    expect(text()).toContain(TEXT.states.loading);

    release?.();
    await settle();
    globalThis.fetch = originalFetch;

    expect(text()).toContain(TEXT.states.emptyFolder);
    expect(text()).toContain(TEXT.states.emptyFolderHint);
    expect(buttonByText(TEXT.actions.upload)).toBeDefined();
  });

  // 业务意图：读取失败必须整区接管为可重试错误态，并暴露服务端 message；
  // 重试按钮要真的重新发起请求（只重置本地 state 不算），成功后回到列表。
  test("列表失败显示服务端错误并可重试，重试成功后渲染文件", async () => {
    listResponses = [
      failure("CLOUD_DRIVE_UPSTREAM_ERROR", "upstream exploded"),
      { status: 200, body: { success: true, data: { items: [fileItem("notes.txt")], nextCursor: null } } },
    ];

    await render();

    const alerts = [...container.querySelectorAll('[role="alert"]')];
    expect(alerts.length).toBe(1);
    expect(text()).toContain(TEXT.states.loadFailed);
    expect(text()).toContain("upstream exploded");
    expect(text()).not.toContain(TEXT.states.emptyFolder);
    expect(listCalls).toBe(1);

    await click(buttonByText(TEXT.actions.retry) as HTMLButtonElement);

    expect(listCalls).toBe(2);
    expect(container.querySelectorAll('[role="alert"]').length).toBe(0);
    expect(text()).toContain("notes.txt");
    expect(text()).toContain(TEXT.columns.name);
  });

  // 业务意图：回收站不在初始视图发请求（切过去才拉取），且空回收站给独立空态而不是文件空态。
  test("切到回收站才请求，空回收站显示回收站空态", async () => {
    listResponses = [EMPTY_PAGE];

    await render();
    expect(trashCalls).toBe(0);

    await click(buttonByText(TEXT.views.trash) as HTMLButtonElement);

    expect(trashCalls).toBe(1);
    expect(text()).toContain(TEXT.states.emptyTrash);
    expect(text()).toContain(TEXT.states.emptyTrashHint);
    expect(text()).not.toContain(TEXT.states.emptyFolder);
  });

  // 业务意图：提交搜索后页面切到紧凑结果视图（不是文件表格），计数、路径与高亮都来自新响应。
  test("提交搜索后渲染紧凑结果与匹配计数", async () => {
    listResponses = [EMPTY_PAGE];
    searchResponse = {
      status: 200,
      body: {
        success: true,
        data: {
          items: [
            {
              fileId: "file-report",
              name: "季度报告.txt",
              path: "/工作/季度报告.txt",
              parentId: "dir-work",
              kind: "file",
              sizeBytes: 4096,
              updatedAt: "2026-10-28T10:00:00Z",
              snippets: [
                {
                  text: "quarterly report content",
                  matches: [{ start: 10, end: 16 }],
                  leadingEllipsis: false,
                  trailingEllipsis: false,
                },
                {
                  text: "annual report summary",
                  matches: [{ start: 7, end: 13 }],
                  leadingEllipsis: false,
                  trailingEllipsis: false,
                },
              ],
              matchCount: 2,
              location: { page: 1, block: null },
              completeness: { status: "ready", missingTextPages: [] },
              stale: false,
              currentVersionId: "version-1",
              returnedVersionId: "version-1",
              newerVersionStatus: null,
              snippet: "quarterly report content",
            },
          ],
          nextCursor: null,
          fileCount: 1,
          matchCount: 2,
        },
      },
    };

    await render();

    const input = container.querySelector("#cloud-drive-search") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    expect(input).not.toBeNull();
    expect(setValue).toBeDefined();
    // happy-dom 下 React 走 input 事件 polyfill：按既有做法用「聚焦 → 原型 setter → keydown」触发表单状态。
    act(() => {
      input.focus();
      setValue?.call(input, "report");
      input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "t", bubbles: true }));
    });
    await settle();
    expect(input.value).toBe("report");

    const form = container.querySelector('form[role="search"]') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(searchCalls).toBe(1);
    expect(text()).toContain("About 1 files, 2 matches");
    expect(text()).toContain("季度报告.txt");
    expect(text()).toContain("Home / 工作");
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelectorAll("mark")).toHaveLength(2);
  });
});
