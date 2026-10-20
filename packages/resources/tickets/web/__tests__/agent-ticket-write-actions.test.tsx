// web/__tests__/agent-ticket-write-actions.test.tsx
// 工单写动作的 hook 级契约（前端合同 §10 第 15–23 条）：字段编辑 / 指派 / 关闭重开 / 标签全量提交 / 成员搜索
// 的请求构造、幂等键换代与「待确认阻止后续修改」的状态机。
//
// 为什么是 hook 级（合同 §10.2 口径 B）：这些动作的入口是弹窗与下拉（`FormDialog` / `Popover` / `ConfirmDialog`），
// 而 Radix 覆盖层在同进程全量运行时不挂载（T02 实测）。用例因此渲染一个**测试内定义的最小组件**：几个 button
// 的 onClick 调 hook 返回的动作函数，DOM 里的 `<pre data-probe>` 输出状态快照。这不是 mock——hook 是生产代码，
// `request()` 与 `unwrap()` 是真实链路，fetch 桩是唯一的外部替身（与 T02 用例同款）。
//
// 环境：happy-dom + react-dom/client；**不用 `mock.module`**；react-i18next 用真实实例 + 本包真字典。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { webTicketDataSource } from "../api/ticket-data-source";
import type { TicketDetail } from "../api/tickets";
import { useTicketDetail } from "../hooks/use-ticket-detail";
import { useTicketLabels } from "../hooks/use-ticket-labels";
import { useTicketMembers } from "../hooks/use-ticket-members";
import { TICKETS_NS, ticketsResources } from "../i18n";
import type { TicketWriteOutcome } from "../lib/ticket-write-outcome";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/** DOM 全局构造器：同进程跑完全部包时其它文件会读写它们，故每例重放；`HTMLElement` 与 `customElements` 成对。 */
const DOM_GLOBALS = [
  "CustomEvent",
  "DOMRect",
  "DocumentFragment",
  "Element",
  "Event",
  "EventTarget",
  "FocusEvent",
  "HTMLElement",
  "HTMLAnchorElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "ResizeObserver",
  "customElements",
] as const;

const originalGlobals = new Map<string, unknown>([
  ...["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, globals[key]] as const),
  ...DOM_GLOBALS.map((key) => [key, globals[key]] as const),
  ["requestAnimationFrame", globals.requestAnimationFrame],
  ["cancelAnimationFrame", globals.cancelAnimationFrame],
  ["getComputedStyle", globals.getComputedStyle],
]);

function applyDomGlobals(): void {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of DOM_GLOBALS) {
    globals[key] = (win as unknown as Record<string, unknown>)[key];
  }
  globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globals.getComputedStyle = win.getComputedStyle.bind(win);
}

applyDomGlobals();

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

const i18n = createInstance();
await i18n.init({
  lng: "zh",
  fallbackLng: "zh",
  defaultNS: TICKETS_NS,
  initAsync: false,
  resources: {
    zh: { [TICKETS_NS]: ticketsResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh },
  },
});

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER = "42";

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };
type RecordedCall = { url: string; method: string; idempotencyKey: string | null; body: unknown };

let calls: RecordedCall[] = [];
let detailResponses: StubResponse[] = [];
let patchResponses: StubResponse[] = [];
let labelResponses: StubResponse[] = [];
let catalogResponse: StubResponse;
let memberResponses: StubResponse[] = [];
let operationResponses: StubResponse[] = [];
let detailCalls = 0;
let patchCalls = 0;
let labelCalls = 0;
let memberCalls = 0;
let operationCalls = 0;

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

/** 队列取数：取到队尾后一直复用最后一条（多数用例只关心「第一次请求拿到什么」）。 */
function nextOf(queue: StubResponse[], index: number): StubResponse {
  const response = queue[Math.min(index, queue.length - 1)];
  if (response === undefined) throw new Error("fetch 桩收到未配置的请求");
  return response;
}

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    // 标签路径以详情 URL 为前缀，必须先判；成员与标签目录同属项目面，故都在详情分支之前。
    if (url.startsWith(`/web/tickets/${PROJECT_ID}/${NUMBER}/labels`)) {
      const response = nextOf(labelResponses, labelCalls);
      labelCalls += 1;
      return jsonResponse(response);
    }
    if (url.startsWith(`/web/ticket-projects/${PROJECT_ID}/labels`)) return jsonResponse(catalogResponse);
    if (url.startsWith(`/web/ticket-projects/${PROJECT_ID}/members`)) {
      const response = nextOf(memberResponses, memberCalls);
      memberCalls += 1;
      return jsonResponse(response);
    }
    if (url.startsWith("/web/ticket-operations/")) {
      const response = nextOf(operationResponses, operationCalls);
      operationCalls += 1;
      return jsonResponse(response);
    }
    // 附件列表：详情页挂载时按工单取一次（页面既有行为），不属于本文件断言的写路径。
    if (url.startsWith(`/web/tickets/${PROJECT_ID}/${NUMBER}/attachments`)) {
      return jsonResponse({ status: 200, body: { success: true, data: { items: [] } } });
    }
    if (url.startsWith(`/web/tickets/${PROJECT_ID}/${NUMBER}`)) {
      if (method === "PATCH") {
        const response = nextOf(patchResponses, patchCalls);
        patchCalls += 1;
        return jsonResponse(response);
      }
      const response = nextOf(detailResponses, detailCalls);
      detailCalls += 1;
      return jsonResponse(response);
    }
    throw new Error(`未预期的请求：${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** `/web/*` 失败信封：HTTP 状态码 + `{ success: false, error }`。 */
function failure(code: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message: "boom" } } };
}

/** 详情 DTO（不含前端回填的 `projectId`），字段与后端 `TicketDetailViewSchema` 一致。 */
function ticketDto(overrides: Partial<Omit<TicketDetail, "projectId">> = {}): Omit<TicketDetail, "projectId"> {
  return {
    issueNumber: NUMBER,
    title: "登录后跳转空白页",
    state: "open",
    author: { id: "user-1", name: "张三", source: "aos" },
    assignee: null,
    labels: [],
    version: "v1",
    providerUpdatedAt: "2026-10-12T08:00:00.000Z",
    syncedAt: "2026-10-12T08:00:01.000Z",
    syncStatus: "ready",
    body: "复现步骤：点击登录后页面空白。",
    pendingOperationId: null,
    ...overrides,
  };
}

function detailSuccess(overrides: Partial<Omit<TicketDetail, "projectId">> = {}): StubResponse {
  return { status: 200, body: { success: true, data: { ticket: ticketDto(overrides) } } };
}

function writeSuccess(overrides: Partial<Omit<TicketDetail, "projectId">> = {}): StubResponse {
  return { status: 200, body: { success: true, data: { ticket: ticketDto(overrides), operationId: "op-write" } } };
}

function accepted(): StubResponse {
  return { status: 202, body: { success: true, data: { operationId: "op-202", status: "uncertain" } } };
}

function operation(status: string): StubResponse {
  return {
    status: 200,
    body: {
      success: true,
      data: {
        operation: {
          operationId: "op-7",
          kind: "issue.update",
          status,
          projectId: PROJECT_ID,
          targetId: NUMBER,
          result: null,
          createdAt: "2026-10-12T08:00:00.000Z",
          updatedAt: "2026-10-12T08:00:01.000Z",
        },
      },
    },
  };
}

// ── 动作结果与状态探针 ──
/** 每次写动作返回的终局，按提交顺序累积（用例据此断言分支，而不是只看请求次数）。 */
let outcomes: string[] = [];
let lastResolution: string | null = null;

/** 记录一次写动作的终局；不触发 React 状态更新，因此不会在 act() 之外引起告警。 */
function track(promise: Promise<TicketWriteOutcome>): void {
  void promise.then((outcome) => {
    outcomes.push(outcome);
  });
}

/** 详情写动作 harness：按钮触发 hook 的动作，`<pre>` 探针暴露状态机。 */
function DetailHarness() {
  const detail = useTicketDetail(PROJECT_ID, NUMBER, webTicketDataSource);
  return (
    <div>
      <pre data-probe="detail">
        {JSON.stringify({
          version: detail.data?.version ?? null,
          title: detail.data?.title ?? null,
          blocked: detail.blocked,
          pendingOperationId: detail.pendingOperationId,
          fieldsConflict: detail.fieldsConflict,
          resolution: detail.resolution,
        })}
      </pre>
      <button
        data-action="submit-fields"
        onClick={() => track(detail.submitFields({ title: "新标题", body: "新正文" }))}
        type="button"
      >
        submit-fields
      </button>
      <button data-action="assign-null" onClick={() => track(detail.assign(null))} type="button">
        assign-null
      </button>
      <button data-action="close" onClick={() => track(detail.changeState("closed"))} type="button">
        close
      </button>
      <button
        data-action="resolve"
        onClick={() => {
          void detail.resolveOperation().then((status) => {
            lastResolution = status;
          });
        }}
        type="button"
      >
        resolve
      </button>
    </div>
  );
}

/** 标签 harness：`ticket` 由 harness 持有并交给 `applyTicket` 回填——这正是「成功后草稿回到服务端集合」的路径。 */
function LabelsHarness() {
  const [ticket, setTicket] = useState<TicketDetail>({ ...ticketDto(), projectId: PROJECT_ID });
  const labels = useTicketLabels(PROJECT_ID, NUMBER, webTicketDataSource, {
    enabled: true,
    ticket,
    blocked: false,
    applyTicket: setTicket,
    reportUncertain: () => {},
    reloadLatest: () => {},
  });
  return (
    <div>
      <pre data-probe="labels">
        {JSON.stringify({
          draftIds: labels.draftIds,
          dirty: labels.dirty,
          catalog: labels.catalog.map((item) => item.id),
        })}
      </pre>
      <button data-action="toggle-l1" onClick={() => labels.toggle("l1")} type="button">
        toggle-l1
      </button>
      <button data-action="toggle-l2" onClick={() => labels.toggle("l2")} type="button">
        toggle-l2
      </button>
      <button data-action="save-labels" onClick={() => track(labels.save())} type="button">
        save-labels
      </button>
    </div>
  );
}

/** 成员 harness：输入框上报关键词（防抖由 hook 承担），按钮触发翻页。 */
function MembersHarness() {
  const members = useTicketMembers(PROJECT_ID, webTicketDataSource, { open: true });
  return (
    <div>
      <pre data-probe="members">
        {JSON.stringify({
          ids: members.members.map((member) => member.userId),
          hasMore: members.hasMore,
          query: members.query,
        })}
      </pre>
      <input
        data-action="members-query"
        onChange={(event) => members.setQuery(event.target.value)}
        value={members.query}
      />
      <button data-action="load-more" onClick={members.loadMore} type="button">
        load-more
      </button>
    </div>
  );
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  applyDomGlobals();
  calls = [];
  outcomes = [];
  lastResolution = null;
  detailCalls = 0;
  patchCalls = 0;
  labelCalls = 0;
  memberCalls = 0;
  operationCalls = 0;
  detailResponses = [detailSuccess()];
  patchResponses = [writeSuccess()];
  labelResponses = [writeSuccess({ version: "v2", labels: [{ id: "l1", name: "缺陷", color: null }] })];
  catalogResponse = {
    status: 200,
    body: {
      success: true,
      data: {
        items: [
          { id: "l1", name: "缺陷", color: null, description: null },
          { id: "l2", name: "文档", color: null, description: null },
        ],
      },
    },
  };
  memberResponses = [
    { status: 200, body: { success: true, data: { items: [{ userId: "user-1", name: "张三" }], total: 2 } } },
    { status: 200, body: { success: true, data: { items: [{ userId: "user-2", name: "李四" }], total: 2 } } },
  ];
  operationResponses = [operation("succeeded")];
  restoreFetch = stubFetch();
  console.error = () => {};
  console.warn = () => {};
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  restoreFetch();
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderHarness(element: ReturnType<typeof createElement>): Promise<void> {
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, element));
  });
  await flush();
}

function probe(label: string): Record<string, unknown> {
  const node = container.querySelector(`[data-probe="${label}"]`);
  if (node === null) throw new Error(`缺少探针 ${label}`);
  return JSON.parse(node.textContent ?? "{}") as Record<string, unknown>;
}

function buttonByAction(action: string): HTMLButtonElement {
  const node = container.querySelector(`[data-action="${action}"]`);
  if (node === null) throw new Error(`缺少按钮 ${action}`);
  return node as HTMLButtonElement;
}

async function clickAction(action: string): Promise<void> {
  await act(async () => {
    buttonByAction(action).click();
  });
  await flush();
}

/**
 * 向受控输入框输入文本：happy-dom 下 React 走「input 事件 polyfill」分支，直接赋 `value` 不触发
 * 受控组件的 `onChange`；按本仓库既有做法用「聚焦 → 原型上的原生 setter 改值 → keydown」三步逼近真实输入。
 */
async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, "value")?.set;
  if (!setter) throw new Error("happy-dom 未在原型上提供 value setter");
  await act(async () => {
    element.focus();
    setter.call(element, value);
    element.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: value.slice(-1) || "a", bubbles: true }) as unknown as Event,
    );
  });
  await flush(2);
}

function callsOf(method: string, prefix: string): RecordedCall[] {
  return calls.filter((call) => call.method === method && call.url.startsWith(prefix));
}

function detailGets(): RecordedCall[] {
  return callsOf("GET", `/web/tickets/${PROJECT_ID}/${NUMBER}`);
}

function paramOf(call: RecordedCall, key: string): string | null {
  return new URL(call.url, "https://localhost:3000").searchParams.get(key);
}

describe("工单写动作（hook 级）", () => {
  // 字段编辑只发本次动作涉及的字段：全字段回写会把页面里的旧值（别人刚改过的内容）一并盖回去，
  // 而幂等键必须随请求发出——没有它，「超时后用户再点一次」会在上游留下两份不同的改动。
  test("submitFields 只发 title / body / expectedVersion 并带幂等键", async () => {
    await renderHarness(createElement(DetailHarness));
    await clickAction("submit-fields");

    const patches = callsOf("PATCH", `/web/tickets/${PROJECT_ID}/${NUMBER}`);
    expect(patches.length).toBe(1);
    expect(patches[0]?.body).toEqual({ title: "新标题", body: "新正文", expectedVersion: "v1" });
    expect(patches[0]?.idempotencyKey).not.toBeNull();
    expect(outcomes).toEqual(["applied"]);
  });

  // 成功返回的新视图就是页面数据（`applyTicket`）：版本随之更新到服务端刚算出的指纹，
  // 且**不再回源**——第二次请求既慢，又会在并发下用旧响应覆盖新响应。
  test("成功返回的工单立即成为页面数据，且没有第二次详情请求", async () => {
    patchResponses = [writeSuccess({ version: "v2", title: "改后的标题" })];
    await renderHarness(createElement(DetailHarness));
    await clickAction("submit-fields");

    const state = probe("detail");
    expect(state.version).toBe("v2");
    expect(state.title).toBe("改后的标题");
    expect(detailGets().length).toBe(1);
  });

  // 取消指派发的是 `assigneeId: null`，与「字段省略（不改）」是两件事：省略会被服务端读成「本次不动负责人」，
  // 用 `||` 兜默认值会把这个区别抹掉，人再也取消不了指派。
  test("assign(null) 发出 assigneeId: null 而不是省略字段", async () => {
    await renderHarness(createElement(DetailHarness));
    await clickAction("assign-null");

    const patches = callsOf("PATCH", `/web/tickets/${PROJECT_ID}/${NUMBER}`);
    expect(patches.length).toBe(1);
    expect(patches[0]?.body).toEqual({ assigneeId: null, expectedVersion: "v1" });
    expect(outcomes).toEqual(["applied"]);
  });

  // 关闭/重开是无草稿的单值动作（裁定三.20）：冲突后自动刷新一次把最新内容与版本取回来，
  // 但**不重发写请求**——重发带着的还是那个过期版本，只会再撞一次 409。
  test("关闭工单遇 409 版本冲突：不重试写入，自动刷新一次详情", async () => {
    patchResponses = [failure("VERSION_CONFLICT", 409)];
    detailResponses = [detailSuccess(), detailSuccess()];
    await renderHarness(createElement(DetailHarness));
    await clickAction("close");

    expect(callsOf("PATCH", `/web/tickets/${PROJECT_ID}/${NUMBER}`).length).toBe(1);
    expect(detailGets().length).toBe(2);
    expect(outcomes).toEqual(["conflict"]);
  });

  // 「未确认的同工单变更阻止后续修改」（方案 §9.6）的硬证据：202 之后写入口全部短路，
  // 后续动作**一个请求都不发**（服务端也会拒绝，界面提前拦住，用户不会白等一次往返）。
  test("202 置位待确认并短路后续写请求", async () => {
    patchResponses = [accepted()];
    await renderHarness(createElement(DetailHarness));
    await clickAction("submit-fields");

    expect(probe("detail").pendingOperationId).toBe("op-202");
    expect(probe("detail").blocked).toBe(true);

    await clickAction("submit-fields");

    expect(callsOf("PATCH", `/web/tickets/${PROJECT_ID}/${NUMBER}`).length).toBe(1);
    expect(outcomes).toEqual(["accepted", "blocked"]);
  });

  // 核对出终态（succeeded）后待确认态必须解除并刷新一次详情：不解除，用户会被一个已经完成的操作
  // 永久锁在只读界面上（详情快照里的 pendingOperationId 也要被抵消，否则刷新又把它带回来）。
  test("核对出 succeeded 后解除待确认并刷新详情", async () => {
    detailResponses = [detailSuccess({ pendingOperationId: "op-7" }), detailSuccess({ pendingOperationId: "op-7" })];
    operationResponses = [operation("succeeded")];
    await renderHarness(createElement(DetailHarness));

    // 跨刷新可见：首屏靠详情快照的 `pendingOperationId` 就进入待确认态，不需要先失败一次写。
    expect(probe("detail").blocked).toBe(true);
    expect(detailGets().length).toBe(1);

    await clickAction("resolve");

    expect(lastResolution).toBe("succeeded");
    expect(probe("detail").pendingOperationId).toBeNull();
    expect(probe("detail").blocked).toBe(false);
    expect(detailGets().length).toBe(2);
  });

  // 核对出非终态（uncertain / pending / needs_review）时**保持**待确认、不刷新详情：结果还没定，
  // 刷新只会把同一份快照再取一遍，而写入口必须继续锁着。
  test("核对出 uncertain 时保持待确认且不刷新", async () => {
    detailResponses = [detailSuccess({ pendingOperationId: "op-7" })];
    operationResponses = [operation("uncertain")];
    await renderHarness(createElement(DetailHarness));

    await clickAction("resolve");

    expect(lastResolution).toBe("uncertain");
    expect(probe("detail").resolution).toBe("uncertain");
    expect(probe("detail").blocked).toBe(true);
    expect(detailGets().length).toBe(1);
  });

  // 标签是**全量集合**语义（PUT 的 `labelIds` 是目标集合，不是增量）：「先勾两个再取消一个」提交的是
  // 剩下的一个；服务端确认后草稿随版本回到服务端集合，再点保存就「没有变更、没有动作、不消耗幂等键」。
  test("标签保存提交全量集合，无变更时不再发请求", async () => {
    await renderHarness(createElement(LabelsHarness));

    await clickAction("toggle-l1");
    await clickAction("toggle-l2");
    await clickAction("toggle-l2");
    expect(probe("labels").draftIds).toEqual(["l1"]);

    await clickAction("save-labels");
    const puts = callsOf("PUT", `/web/tickets/${PROJECT_ID}/${NUMBER}/labels`);
    expect(puts.length).toBe(1);
    expect(puts[0]?.body).toEqual({ labelIds: ["l1"], expectedVersion: "v1" });
    expect(outcomes).toEqual(["applied"]);
    expect(probe("labels").dirty).toBe(false);

    await clickAction("save-labels");
    expect(callsOf("PUT", `/web/tickets/${PROJECT_ID}/${NUMBER}/labels`).length).toBe(1);
    expect(outcomes).toEqual(["applied", "blocked"]);
  });

  // 成员候选由服务端过滤：关键词变化必须带 `q` **并回到第一页**（在「搜索 A 的结果」里留着第 3 页，
  // 会让用户选中一个与 A 无关的人）；「加载更多」带同一关键词的下一页。
  test("成员搜索带 q 并回到第一页，加载更多翻下一页", async () => {
    memberResponses = [
      { status: 200, body: { success: true, data: { items: [{ userId: "user-1", name: "张三" }], total: 2 } } },
      { status: 200, body: { success: true, data: { items: [{ userId: "user-2", name: "张四" }], total: 2 } } },
      { status: 200, body: { success: true, data: { items: [{ userId: "user-3", name: "张五" }], total: 3 } } },
    ];
    await harnessMembers();

    const first = callsOf("GET", `/web/ticket-projects/${PROJECT_ID}/members`);
    expect(first.length).toBe(1);
    expect(paramOf(first[0] as RecordedCall, "page")).toBe("1");
    expect(paramOf(first[0] as RecordedCall, "q")).toBeNull();
    expect(probe("members").hasMore).toBe(true);

    const input = container.querySelector('[data-action="members-query"]') as HTMLInputElement;
    await typeInto(input, "张");
    // 防抖 300ms：等到窗口过去，请求才该发出（输入即请求会让每次按键都打一次服务端）。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flush();

    const searched = callsOf("GET", `/web/ticket-projects/${PROJECT_ID}/members`);
    expect(searched.length).toBe(2);
    expect(paramOf(searched[1] as RecordedCall, "q")).toBe("张");
    expect(paramOf(searched[1] as RecordedCall, "page")).toBe("1");
    // 沿用旧结果的痕迹必须消失：列表被搜索页整页替换（旧 `user-1` 不在里面），否则用户会在「搜索张」的
    // 结果里看到一个与关键词无关的人。
    expect(probe("members").ids).toEqual(["user-2"]);

    await clickAction("load-more");

    const paged = callsOf("GET", `/web/ticket-projects/${PROJECT_ID}/members`);
    expect(paged.length).toBe(3);
    expect(paramOf(paged[2] as RecordedCall, "page")).toBe("2");
    expect(paramOf(paged[2] as RecordedCall, "q")).toBe("张");
    // 翻页是在**搜索结果**上继续：页码按「已加载页数 + 1」推进，不会退回无关键词的第一页。
    expect(probe("members").ids).toEqual(["user-2", "user-3"]);
  });

  // 幂等冲突说明「同一把键被用于不同内容」：继续复用旧键只会一直撞同一堵墙，必须换代后重试。
  test("幂等冲突后换代，下一次提交用新键", async () => {
    patchResponses = [failure("IDEMPOTENCY_CONFLICT", 409), writeSuccess()];
    await renderHarness(createElement(DetailHarness));

    await clickAction("submit-fields");
    await clickAction("submit-fields");

    const patches = callsOf("PATCH", `/web/tickets/${PROJECT_ID}/${NUMBER}`);
    expect(patches.length).toBe(2);
    expect(patches[1]?.idempotencyKey).not.toBe(patches[0]?.idempotencyKey);
    expect(outcomes).toEqual(["failed", "applied"]);
  });
});

/** 只挂成员 harness 的便捷入口（用例体只关心请求与探针）。 */
async function harnessMembers(): Promise<void> {
  await renderHarness(createElement(MembersHarness));
}
