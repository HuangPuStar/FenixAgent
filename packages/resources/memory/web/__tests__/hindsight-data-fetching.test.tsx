// web/__tests__/hindsight-data-fetching.test.tsx
// 钉住「手写取数（`useCallback` + `useEffect` + `setState`）改用 `useRequest`」之后的取数契约（§3.4）：
//   ① 失败态是独立分支（`role="alert"` + 重试入口），不得回落成空态 / 未配置态 / 上一份旧数据；
//   ② 参数变化触发的重查（`refreshDeps` / `ready`）真的发得出去、重试真的重新请求；
//   ③ 后发覆盖先发：慢的旧响应不得覆盖后发出的新结果。
//
// 取数链路走**真实 `request()`**，只桩掉 `globalThis.fetch`——4xx/5xx → `unwrap()` 抛 `ApiError` →
// `useRequest` 的 `error`/`onError` 整条链路都在断言范围内。若改成 mock 域模块，最易错的那条链路
// （§5.2「`request()` 对失败不 throw」）会被藏起来，测试反而会假绿。
//
// 断言只碰结构与数据（角色、按钮、数据里的标题/正文），不碰翻译文案：文案取决于同进程 i18n 单例状态
// （见 hindsight-failure-notice.test.tsx 的同款说明）。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import i18next from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { HINDSIGHT_NS, hindsightResources } from "../i18n";
import { DataView as HindsightDataView } from "../pages/hindsight/components/DataView";
import { DocumentsView } from "../pages/hindsight/components/DocumentsView";
import { MemoryDetailModal } from "../pages/hindsight/components/MemoryDetailModal";
import { MemoryDetailPanel } from "../pages/hindsight/components/MemoryDetailPanel";
import { MemoriesPage } from "../pages/hindsight/MemoriesPage";
import type { MemoryTableRow } from "../pages/hindsight/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = win.document;

/** 用本包真实字典初始化一个**独立** i18n 实例经 Provider 传入（不注册全局单例）。 */
const i18n = i18next.createInstance();
await i18n.init({
  lng: "en",
  ns: HINDSIGHT_NS,
  defaultNS: HINDSIGHT_NS,
  resources: { en: { [HINDSIGHT_NS]: hindsightResources.en } },
});

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

/** 在途请求队列：用例按需决定「先回谁、后回谁」，竞态用例据此构造乱序到达。 */
let pending: Array<{ url: string; resolve: (response: Response) => void }> = [];
let requestUrls: string[] = [];
/** 被记录下来的 `console.error` 文本（请求层与各 `onError` 都写它）。 */
let loggedErrors: string[] = [];

/** 以真实响应形态构造响应体：`content-type` 决定 `request()` 走 JSON 分支。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 失效响应：`{ success: false }` 由 `unwrap()` 转成抛出的 `ApiError`（HTTP 层不 throw）。 */
function failureResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ success: false, error: { code, message } }, status);
}

/** 把 `fetch` 换成「手动放行」的版本：请求发出即入队，由用例决定何时以什么结果回应。 */
function stubFetch(): void {
  pending = [];
  requestUrls = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    requestUrls.push(url);
    return new Promise<Response>((resolve) => {
      pending.push({ url, resolve });
    });
  }) as typeof fetch;
}

/** 回应一条在途请求并把它移出队列（`requestUrls` 才是累计计数，`pending` 表示当前在途）。 */
function respond(response: Response, index = 0): void {
  const item = pending[index];
  if (!item) throw new Error(`没有第 ${index} 条在途请求`);
  pending.splice(index, 1);
  item.resolve(response);
}

let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

/** 冲刷一次挂起的取数：响应到达 → `request()` → `useRequest` 落 state → 重渲染，全在一次 act 内。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 渲染一个用例（带字典 Provider），返回可查询的容器。 */
function render(element: ReactElement): HTMLElement {
  const container = win.document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
  act(() => root?.render(createElement(I18nextProvider, { i18n }, element)));
  return container;
}

/** 重渲染同一个根（用于「props 变化触发重查」的用例），保持组件实例不重建。 */
function rerender(element: ReactElement): void {
  act(() => root?.render(createElement(I18nextProvider, { i18n }, element)));
}

/** 开始记录 `console.error`：失败路径保留诊断是既有行为，用例只断言「确实记了」。 */
function captureConsoleError(): void {
  loggedErrors = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
}

describe("hindsight 取数三态与竞态", () => {
  // 状态取数失败是授权/服务故障，不是「产品未配置」：必须渲染可重试的失败块。
  // 这条同时钉住「以 data 为准」的派生——失败时 `data` 为 undefined，`enabled` 落到 false，
  // 若失败没有独立分支，界面会显示「未配置」空态，把故障伪装成配置问题（§3.4 禁止）。
  test("状态取数失败渲染失败块，重试重新请求并在成功后撤销失败块", async () => {
    stubFetch();
    captureConsoleError();
    const container = render(createElement(MemoriesPage));

    expect(pending.length).toBe(1);
    expect(requestUrls[0]).toContain("/web/hindsight/status");

    respond(failureResponse("service_unavailable", "Hindsight service unavailable", 503));
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(loggedErrors.join(" ")).toContain("Failed to get Hindsight status");

    const retry = alert?.querySelector("button") as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    act(() => retry?.click());
    expect(requestUrls.length).toBe(2);

    // 重试成功但服务端说「未启用」：此时才该走未配置空态，失败块必须消失。
    respond(jsonResponse({ success: true, data: { enabled: false } }));
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // 文档列表：失败时 `documents` 为 `[]`，不给失败分支就会渲染「暂无文档」——把取数失败伪装成空数据。
  // 本用例钉住失败块存在，且重试成功后真的渲染出服务端返回的那一行。
  test("文档列表取数失败渲染失败块，重试成功后渲染数据行", async () => {
    stubFetch();
    captureConsoleError();
    const container = render(createElement(DocumentsView));

    expect(requestUrls[0]).toContain("/web/hindsight/documents?limit=20&offset=0");

    respond(failureResponse("SERVER_ERROR", "boom", 500));
    await settle();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();

    const retry = alert?.querySelector("button") as HTMLButtonElement | null;
    act(() => retry?.click());
    expect(requestUrls.length).toBe(2);

    respond(
      jsonResponse({
        success: true,
        data: {
          items: [
            {
              document_id: "doc-1",
              bank_id: "bank-1",
              title: "季度复盘.md",
              created_at: "2026-09-01T00:00:00.000Z",
              updated_at: "2026-09-01T00:00:00.000Z",
              chunk_count: 3,
              memory_unit_count: 5,
              tags: [],
            },
          ],
          total: 1,
        },
      }),
    );
    await settle();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("季度复盘.md");
  });

  // 竞态（后发覆盖先发）：切到 B 之后才回来的是 A 的响应，界面必须仍是 B 的数据。
  // 改造前这里由手写 effect + setState 决定谁最后落地，容易让慢的旧响应覆盖新选择。
  test("详情取数乱序到达时后发结果不被先发覆盖", async () => {
    stubFetch();
    captureConsoleError();
    const memoryA: MemoryTableRow = { id: "mem-a", text: "A 的正文", fact_type: "world" };
    const memoryB: MemoryTableRow = { id: "mem-b", text: "B 的正文", fact_type: "world" };
    const container = render(createElement(MemoryDetailPanel, { memory: memoryA, onClose: () => {}, inPanel: true }));

    expect(pending.length).toBe(1);
    // 切到 B：`refreshDeps: [memory.id]` 触发第二次请求，A 仍在途。
    rerender(createElement(MemoryDetailPanel, { memory: memoryB, onClose: () => {}, inPanel: true }));
    expect(pending.length).toBe(2);

    respond(jsonResponse({ success: true, data: { id: "mem-b", text: "B 的正文", type: "world" } }), 1);
    await settle();
    expect(container.textContent).toContain("B 的正文");

    // 迟到的 A：不得覆盖已经落地的 B。
    respond(jsonResponse({ success: true, data: { id: "mem-a", text: "A 的正文", type: "world" } }), 0);
    await settle();
    expect(container.textContent).toContain("B 的正文");
    expect(container.textContent).not.toContain("A 的正文");
  });

  // 详情失败不得显示「另一条记忆」的正文：`useRequest` 失败时会保留上一次成功的数据，
  // 若直接把它当详情用，标题取自新选中项、正文却是上一条（数据错乱，且用户看不出失败）。
  test("详情取数失败时不展示上一条记忆的正文，改为可见失败块", async () => {
    stubFetch();
    captureConsoleError();
    const memoryA: MemoryTableRow = { id: "mem-a", text: "A 的正文", fact_type: "world" };
    const memoryB: MemoryTableRow = { id: "mem-b", text: "B 的正文", fact_type: "world" };
    const container = render(createElement(MemoryDetailPanel, { memory: memoryA, onClose: () => {}, inPanel: true }));

    respond(jsonResponse({ success: true, data: { id: "mem-a", text: "A 的正文", type: "world" } }));
    await settle();
    expect(container.textContent).toContain("A 的正文");

    rerender(createElement(MemoryDetailPanel, { memory: memoryB, onClose: () => {}, inPanel: true }));
    expect(requestUrls.length).toBe(2);
    respond(failureResponse("SERVER_ERROR", "boom", 500));
    await settle();

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("A 的正文");
    expect(loggedErrors.join(" ")).toContain("Failed to fetch memory details");
  });

  // 详情弹窗：关闭状态（memoryId 为 null）不发请求，打开才取数，失败只记诊断不抛——
  // 覆盖「`ready` 条件请求 + `refreshDeps` 重取」在弹窗上的组合语义。
  //
  // 为什么不断言弹窗内的失败块：弹窗内容经 radix Portal 挂载，而 `@radix-ui/react-use-layout-effect`
  // 在**模块求值期**用 `globalThis.document` 决定是否使用 `useLayoutEffect`——本文件的静态导入早于
  // 下方注入的 DOM 全局，portal 因此永不挂载（同进程里先被谁求值还取决于测试文件顺序）。
  // 弹窗的失败分支与 `MemoryDetailPanel` 共用同一份 `failure` 派生与失败块组件，故由上面两个用例覆盖。
  test("详情弹窗关闭时不取数，打开后取数且失败只记诊断", async () => {
    stubFetch();
    captureConsoleError();
    render(createElement(MemoryDetailModal, { memoryId: null, onClose: () => {} }));
    expect(requestUrls.length).toBe(0);

    rerender(createElement(MemoryDetailModal, { memoryId: "mem-a", onClose: () => {} }));
    expect(requestUrls.length).toBe(1);
    expect(requestUrls[0]).toContain("/web/hindsight/memories/mem-a");

    respond(failureResponse("SERVER_ERROR", "boom", 500));
    await settle();

    expect(loggedErrors.join(" ")).toContain("Error loading memory");
  });

  // 图谱取数失败要落成可见失败块 + 重试；观察类型的整合状态是辅助信息，图谱没数据时不该单独发请求
  // （改造前它只在图谱成功后顺带取，这条钉住 `ready` 的前置数据语义没有被改写成「并行发出去」）。
  test("图谱取数失败渲染失败块且不并发取整合状态，重试重新请求", async () => {
    stubFetch();
    captureConsoleError();
    const container = render(createElement(HindsightDataView, { factType: "observation" }));

    expect(pending.length).toBe(1);
    expect(requestUrls[0]).toContain("/web/hindsight/graph?type=observation");
    expect(requestUrls.some((url) => url.includes("/web/hindsight/bank-stats"))).toBe(false);

    respond(failureResponse("SERVER_ERROR", "boom", 500));
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    const retry = alert?.querySelector("button") as HTMLButtonElement | null;
    act(() => retry?.click());
    expect(requestUrls.length).toBe(2);
  });
});
