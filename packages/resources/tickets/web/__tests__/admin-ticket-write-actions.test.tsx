// web/__tests__/admin-ticket-write-actions.test.tsx
// 管理面写动作的 hook 级契约：字段编辑、指派、关闭、标签全量提交、成员候选、附件上传在 `/api/system/**`
// 镜像端点上的请求构造、凭据注入与失败重试。
//
// 为什么是 hook 级：编辑与关闭的入口是 Radix 弹窗（`FormDialog` / `ConfirmDialog`），而覆盖层在 happy-dom
// 下不挂载（同进程实测内容为空），页面级用例无法驱动它们。这里渲染**测试内定义的最小组件**：按钮的 onClick
// 调 hook 返回的动作函数，`<pre data-probe>` 输出状态快照。这不是 mock——hook 是生产代码，`request()`
// 与 `unwrap()` 是真实链路，fetch 桩是唯一的外部替身（与 `agent-ticket-write-actions.test.tsx` 同款）。
//
// 与 `admin-ticket-detail-page.test.tsx` 的分工：那边钉页面装配（行打开、坐标、列表上下文、回门），这边钉
// 写路径的**请求面与幂等语义**——同一套 hook 在两种数据源下的差异全在这层。
//
// 环境：happy-dom + react-dom/client；**不用 `mock.module`**；react-i18next 用真实实例 + 本包真字典。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { clearAdminKey, setAdminKey } from "@fenix/web-runtime/lib/admin-key";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { systemTicketDataSource, systemTicketsApi } from "../api/system-tickets";
import type { TicketComment } from "../api/ticket-comments";
import type { TicketDetail } from "../api/tickets";
import { useTicketAttachments } from "../hooks/use-ticket-attachments";
import { useTicketDetail } from "../hooks/use-ticket-detail";
import { useTicketLabels } from "../hooks/use-ticket-labels";
import { useTicketMembers } from "../hooks/use-ticket-members";
import { TICKETS_NS, ticketsResources } from "../i18n";
import {
  clearPlatformAuditAuthors,
  isPlatformAuthoredComment,
  platformAuditAuthorIdsSnapshot,
  toPlatformCommentView,
} from "../lib/platform-audit-author";
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
  ...["window", "document", "navigator", "sessionStorage", "location", "IS_REACT_ACT_ENVIRONMENT"].map(
    (key) => [key, globals[key]] as const,
  ),
  ...DOM_GLOBALS.map((key) => [key, globals[key]] as const),
  ["requestAnimationFrame", globals.requestAnimationFrame],
  ["cancelAnimationFrame", globals.cancelAnimationFrame],
  ["getComputedStyle", globals.getComputedStyle],
]);

function applyDomGlobals(): void {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  // master key 落在 sessionStorage（`@fenix/web-runtime/lib/admin-key`），凭据用例要能清空它。
  globals.sessionStorage = win.sessionStorage;
  globals.location = win.location;
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

const ADMIN_KEY = "sys-key-admin-1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER = "42";

const TICKETS_PATH = `/api/system/tickets/${PROJECT_ID}/${NUMBER}`;
const COMMENTS_PATH = `${TICKETS_PATH}/comments`;
const LABELS_PATH = `${TICKETS_PATH}/labels`;
const ATTACHMENTS_PATH = `${TICKETS_PATH}/attachments`;
/** 项目级目录（标签 / 成员）收在工单前缀之下：`/api/system/tickets/:projectId/{labels,members}`。 */
const CATALOG_PATH = `/api/system/tickets/${PROJECT_ID}`;

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };
type RecordedCall = {
  url: string;
  method: string;
  authorization: string | null;
  idempotencyKey: string | null;
  body: unknown;
};

let calls: RecordedCall[] = [];
/** 路由表：`"<METHOD> <pathname>"` → 响应队列（取到队尾后一直复用最后一条）。 */
let routes = new Map<string, StubResponse[]>();
let routeCalls = new Map<string, number>();

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

/** 注册一条路由；同一 key 多次调用即排队（用来表达「第一次失败、重试成功」）。 */
function route(method: string, path: string, ...responses: StubResponse[]): void {
  routes.set(`${method} ${path}`, responses);
}

/** 请求体：JSON 解析成对象，multipart 原样保留（上传用例按 FormData 断言）。 */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return;
  if (typeof body === "string") return JSON.parse(body);
  return body;
}

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      authorization: headers.get("authorization"),
      idempotencyKey: headers.get("idempotency-key"),
      body: parseBody(init?.body),
    });

    const [pathname] = url.split("?");
    const key = `${method} ${pathname}`;
    const queue = routes.get(key);
    if (queue === undefined) throw new Error(`未预期的请求：${key}`);
    const index = routeCalls.get(key) ?? 0;
    routeCalls.set(key, index + 1);
    return jsonResponse(queue[Math.min(index, queue.length - 1)]);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** `/api/system/*` 成功信封：`{ success: true, data }`。 */
function ok(data: unknown, status = 200): StubResponse {
  return { status, body: { success: true, data } };
}

/** `/api/system/*` 失败信封：`{ error: { code, message } }`（**没有** `success: false`，与 `/web` 面不同）。 */
function fail(status: number, code: string, message = "boom"): StubResponse {
  return { status, body: { error: { code, message } } };
}

// ── 夹具 ──
function ticketDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

const detailSuccess = (overrides: Record<string, unknown> = {}): StubResponse => ok({ ticket: ticketDto(overrides) });
const writeSuccess = (overrides: Record<string, unknown> = {}): StubResponse =>
  ok({ ticket: ticketDto(overrides), operationId: "op-write" });

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  applyDomGlobals();
  win.sessionStorage.clear();
  setAdminKey(ADMIN_KEY);
  // 平台审计主体识别是进程级状态（跨渲染存活，这正是它的用途），用例之间必须复位。
  clearPlatformAuditAuthors();
  calls = [];
  outcomes.length = 0;
  routes = new Map();
  routeCalls = new Map();
  restoreFetch = stubFetch();
  console.error = () => {};
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container.remove();
  restoreFetch();
  clearAdminKey();
  console.error = originalConsoleError;
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

async function renderView(element: ReactElement): Promise<void> {
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, element));
  });
  await flush();
}

function probe(name: string): string {
  return container.querySelector(`[data-probe="${name}"]`)?.textContent ?? "";
}

function button(action: string): HTMLButtonElement {
  const found = container.querySelector(`[data-action="${action}"]`);
  if (found === null) throw new Error(`未渲染动作按钮：${action}`);
  return found as unknown as HTMLButtonElement;
}

async function press(action: string): Promise<void> {
  await act(async () => {
    button(action).click();
  });
  await flush();
}

function fileOf(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

const requestsTo = (path: string): RecordedCall[] => calls.filter((call) => call.url.split("?")[0] === path);

/** 记录一次写动作的终局；不触发 React 状态更新，因此不会在 act() 之外引起告警。 */
const outcomes: TicketWriteOutcome[] = [];
function track(promise: Promise<TicketWriteOutcome>): void {
  void promise.then((outcome) => {
    outcomes.push(outcome);
  });
}

// ── 被测组件的驱动面 ──

/** 详情写动作：字段编辑 / 指派 / 关闭，探针输出状态机快照。 */
function DetailProbe(): ReactElement {
  const detail = useTicketDetail(PROJECT_ID, NUMBER, systemTicketDataSource);
  return createElement(
    "div",
    null,
    createElement(
      "pre",
      { "data-probe": "detail" },
      JSON.stringify({
        version: detail.data?.version ?? null,
        title: detail.data?.title ?? null,
        state: detail.data?.state ?? null,
        assignee: detail.data?.assignee?.name ?? null,
        blocked: detail.blocked,
        pendingOperationId: detail.pendingOperationId,
      }),
    ),
    createElement(
      "button",
      {
        "data-action": "submit-fields",
        onClick: () => track(detail.submitFields({ title: "新标题", body: "新正文" })),
        type: "button",
      },
      "submit-fields",
    ),
    createElement(
      "button",
      { "data-action": "assign", onClick: () => track(detail.assign("user-2")), type: "button" },
      "assign",
    ),
    createElement(
      "button",
      { "data-action": "close", onClick: () => track(detail.changeState("closed")), type: "button" },
      "close",
    ),
  );
}

/** 标签：`ticket` 由 harness 持有并交给 `applyTicket` 回填——这正是「成功后草稿回到服务端集合」的路径。 */
function LabelsProbe(): ReactElement {
  const [ticket, setTicket] = useState<TicketDetail>({
    ...(ticketDto({ labels: [{ id: "label-1", name: "bug", color: "ff0000" }] }) as unknown as TicketDetail),
    projectId: PROJECT_ID,
  });
  const labels = useTicketLabels(PROJECT_ID, NUMBER, systemTicketDataSource, {
    enabled: true,
    ticket,
    blocked: false,
    applyTicket: setTicket,
    reportUncertain: () => {},
    reloadLatest: () => {},
  });
  return createElement(
    "div",
    null,
    createElement(
      "pre",
      { "data-probe": "labels" },
      JSON.stringify({
        catalog: labels.catalog.map((item) => item.id),
        draftIds: labels.draftIds,
        dirty: labels.dirty,
      }),
    ),
    createElement(
      "button",
      { "data-action": "toggle-label-2", onClick: () => labels.toggle("label-2"), type: "button" },
      "toggle-label-2",
    ),
    createElement(
      "button",
      { "data-action": "save-labels", onClick: () => track(labels.save()), type: "button" },
      "save",
    ),
  );
}

/** 成员候选：只在管理面这一侧出现的取数路径（系统镜像的项目成员端点）。 */
function MembersProbe(): ReactElement {
  const members = useTicketMembers(PROJECT_ID, systemTicketDataSource, { open: true });
  return createElement(
    "div",
    null,
    createElement(
      "pre",
      { "data-probe": "members" },
      JSON.stringify({ names: members.members.map((item) => item.name), hasMore: members.hasMore }),
    ),
    createElement(
      "button",
      { "data-action": "search-members", onClick: () => members.setQuery("李"), type: "button" },
      "search",
    ),
    createElement("button", { "data-action": "load-more", onClick: () => members.loadMore(), type: "button" }, "more"),
  );
}

/** 附件上传：单文件 multipart 打到系统镜像端点。 */
function AttachmentsProbe(): ReactElement {
  const attachments = useTicketAttachments(PROJECT_ID, NUMBER, systemTicketDataSource, {
    enabled: true,
    onUncertain: () => {},
  });
  return createElement(
    "div",
    null,
    createElement(
      "pre",
      { "data-probe": "attachments" },
      JSON.stringify({ items: attachments.attachments.map((item) => item.name), uploads: attachments.uploads.length }),
    ),
    createElement(
      "button",
      { "data-action": "add-file", onClick: () => attachments.addFiles([fileOf("复现截图.png", 4)]), type: "button" },
      "add",
    ),
  );
}

describe("管理面写动作（hook 级）", () => {
  // 业务意图：字段编辑在管理面走的是 PATCH 镜像端点，载荷只带本次动作的字段 + 提交那一刻的版本，并带上一把
  // 幂等键——缺任何一项，服务端要么拒绝（400/409），要么无法对重复提交去重。
  test("编辑提交：PATCH 系统镜像端点，载荷含标题/正文/期望版本与幂等键", async () => {
    route("GET", TICKETS_PATH, detailSuccess());
    route("PATCH", TICKETS_PATH, writeSuccess({ title: "新标题", body: "新正文", version: "v2" }));
    await renderView(createElement(DetailProbe));
    await press("submit-fields");

    const [request] = requestsTo(TICKETS_PATH).filter((call) => call.method === "PATCH");
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(request?.idempotencyKey).toBeTruthy();
    expect(request?.body).toEqual({ title: "新标题", body: "新正文", expectedVersion: "v1" });
    // 成功即就地替换页面数据：不再回源一次详情（第二次请求既慢又可能用旧响应覆盖新响应）。
    expect(probe("detail")).toContain('"title":"新标题"');
    expect(probe("detail")).toContain('"version":"v2"');
    expect(requestsTo(TICKETS_PATH).filter((call) => call.method === "GET").length).toBe(1);
  });

  // 业务意图：写失败必须能原样重试并**复用同一把幂等键**——重试换成新键会让服务端把同一次动作当成两次，
  // 在账本里留下两条在途操作。
  test("编辑提交失败（500）后可重试，重试复用同一把幂等键并最终生效", async () => {
    route("GET", TICKETS_PATH, detailSuccess());
    route("PATCH", TICKETS_PATH, fail(500, "INTERNAL_ERROR"), writeSuccess({ title: "新标题", version: "v2" }));
    await renderView(createElement(DetailProbe));

    await press("submit-fields");
    expect(outcomes).toEqual(["failed"]);
    expect(probe("detail")).toContain('"title":"登录后跳转空白页"');

    await press("submit-fields");
    const patches = requestsTo(TICKETS_PATH).filter((call) => call.method === "PATCH");
    expect(patches.length).toBe(2);
    expect(patches[1]?.idempotencyKey).toBe(patches[0]?.idempotencyKey);
    expect(outcomes).toEqual(["failed", "applied"]);
    expect(probe("detail")).toContain('"title":"新标题"');
  });

  // 业务意图：指派走同一个 PATCH（同一个写状态机、不同幂等键），成功后负责人以服务端返回的新视图为准。
  test("指派：PATCH 携带 assigneeId，成功后负责人就地更新", async () => {
    route("GET", TICKETS_PATH, detailSuccess());
    route("PATCH", TICKETS_PATH, writeSuccess({ assignee: { id: "user-2", name: "李四", source: "aos" } }));
    await renderView(createElement(DetailProbe));
    await press("assign");

    const [request] = requestsTo(TICKETS_PATH).filter((call) => call.method === "PATCH");
    expect(request?.body).toEqual({ assigneeId: "user-2", expectedVersion: "v1" });
    expect(probe("detail")).toContain('"assignee":"李四"');
  });

  // 业务意图：关闭是单值动作，状态经 PATCH 提交；上游结果未定（202）时页面进入待确认态并**短路后续写**，
  // 不再发第二次请求——服务端已在途，重发只会让账本多一条。
  test("关闭：PATCH 提交 state=closed；202 置待确认并短路后续写", async () => {
    route("GET", TICKETS_PATH, detailSuccess());
    route("PATCH", TICKETS_PATH, ok({ operationId: "op-202", status: "uncertain" }, 202));
    await renderView(createElement(DetailProbe));

    await press("close");
    const [request] = requestsTo(TICKETS_PATH).filter((call) => call.method === "PATCH");
    expect(request?.body).toEqual({ state: "closed", expectedVersion: "v1" });
    expect(outcomes).toEqual(["accepted"]);
    expect(probe("detail")).toContain('"pendingOperationId":"op-202"');

    await press("close");
    expect(requestsTo(TICKETS_PATH).filter((call) => call.method === "PATCH").length).toBe(1);
    expect(outcomes).toEqual(["accepted", "blocked"]);
  });

  // 业务意图：标签的候选目录来自项目端点、挂载在工单标签端点上，两面在管理面都必须带 master key；
  // 保存是**全量集合**语义（`labelIds` 是目标集合），并同样要 `expectedVersion` 才不会被并发覆盖。
  test("标签：目录取自系统项目端点，保存 PUT 全量集合", async () => {
    route(
      "GET",
      `${CATALOG_PATH}/labels`,
      ok({
        items: [
          { id: "label-1", name: "bug", color: "ff0000", description: null },
          { id: "label-2", name: "frontend", color: null, description: null },
        ],
      }),
    );
    route("PUT", LABELS_PATH, writeSuccess({ labels: [{ id: "label-1", name: "bug", color: "ff0000" }] }));
    await renderView(createElement(LabelsProbe));

    const catalog = requestsTo(`${CATALOG_PATH}/labels`)[0];
    expect(catalog?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(probe("labels")).toContain('"catalog":["label-1","label-2"]');

    await press("toggle-label-2");
    expect(probe("labels")).toContain('"dirty":true');

    await press("save-labels");
    const [request] = requestsTo(LABELS_PATH);
    expect(request?.method).toBe("PUT");
    expect(request?.idempotencyKey).toBeTruthy();
    // 全量集合语义：服务端当前集合 + 新勾选的一项，且顺序稳定（顺序参与服务端幂等指纹）。
    expect(request?.body).toEqual({ labelIds: ["label-1", "label-2"], expectedVersion: "v1" });
    expect(outcomes).toEqual(["applied"]);
  });

  // 业务意图：可指派成员的候选来自项目成员端点（服务端已收窄成 `{userId,name}`），管理面同样走系统凭据；
  // 关键词与翻页都由服务端完成，前端不做本地全量过滤。
  test("成员候选：系统项目成员端点，带关键词与翻页", async () => {
    route(
      "GET",
      `${CATALOG_PATH}/members`,
      ok({ items: [{ userId: "user-2", name: "李四" }], total: 2 }),
      ok({ items: [{ userId: "user-3", name: "王五" }], total: 2 }),
    );
    await renderView(createElement(MembersProbe));
    expect(probe("members")).toContain('"hasMore":true');

    await press("load-more");
    const [first, second] = requestsTo(`${CATALOG_PATH}/members`);
    expect(first?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(first?.url).toContain("page=1");
    expect(second?.url).toContain("page=2");
    expect(probe("members")).toContain("王五");
  });

  // 业务意图：附件上传在管理面是同一个 multipart 单文件协议（字段名 `file`），只是换到了系统端点；成功后
  // 新附件前插列表，用户不必刷新就能看到它。
  test("附件上传：multipart 单文件打到系统镜像端点并前插列表", async () => {
    route("GET", ATTACHMENTS_PATH, ok({ items: [] }));
    route(
      "POST",
      ATTACHMENTS_PATH,
      ok(
        { attachment: { attachmentId: "8", name: "复现截图.png", size: 4, createdAt: null }, operationId: "op-a" },
        201,
      ),
    );
    await renderView(createElement(AttachmentsProbe));
    await press("add-file");

    const [request] = requestsTo(ATTACHMENTS_PATH).filter((call) => call.method === "POST");
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(request?.idempotencyKey).toBeTruthy();
    const form = request?.body;
    expect(form instanceof FormData).toBe(true);
    expect((form as FormData).get("file")).toBeInstanceOf(File);
    expect(probe("attachments")).toContain("复现截图.png");
  });

  // 业务意图：凭据**每次请求现取**（门内 401 会清掉它，缓存一份会让下一次请求继续用失效凭据）：清掉 key 后
  // 的请求不带 `Authorization`，由服务端给出 401、回门流程照常触发。
  test("凭据现取：清掉 master key 后的请求不再带 Authorization", async () => {
    route("GET", TICKETS_PATH, detailSuccess());
    await renderView(createElement(DetailProbe));
    expect(requestsTo(TICKETS_PATH)[0]?.authorization).toBe(`Bearer ${ADMIN_KEY}`);

    clearAdminKey();
    await press("close");
    const patch = requestsTo(TICKETS_PATH).filter((call) => call.method === "PATCH")[0];
    expect(patch?.authorization).toBeNull();
  });

  // 业务意图：平台写入的评论以系统托管租户为主体，而它在评论视图里与其他 AOS 用户长得一样——界面必须把它
  // 呈现成「平台系统管理员」而不是身份目录里的账号名。识别只用不会误判的信号：本页经平台面写过的那条
  // （按 commentId，刚写入时作者是 external/id null，按 id 判会漏掉操作者自己刚发的那条），以及由它解析出的
  // 审计主体 id（覆盖同一主体此前的评论）。组织成员写的评论必须原样不动。
  test("平台审计主体识别：本页写入的评论与同一主体此前的评论呈现为平台系统管理员", async () => {
    const platformComment = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      commentId: "c-9",
      issueNumber: NUMBER,
      body: "平台侧追问",
      author: { id: null, name: "admin", source: "external" },
      version: "c1",
      providerUpdatedAt: "2026-10-12T09:00:00.000Z",
      ...overrides,
    });
    const label = "平台系统管理员";
    route("POST", COMMENTS_PATH, ok({ comment: platformComment(), operationId: "op-comment" }, 201));
    route(
      "GET",
      COMMENTS_PATH,
      ok({
        items: [
          // 服务端在后续读取里解析出真实主体（身份目录里的账号名仍是 "admin"）。
          platformComment({ author: { id: "usr_system", name: "admin", source: "aos" } }),
          // 同一主体**此前**写的评论：不在本页写过，只能靠学到的 id 认出来。
          platformComment({
            commentId: "c-3",
            body: "早先的系统留言",
            author: { id: "usr_system", name: "admin", source: "aos" },
          }),
          // 组织成员写的评论：不得被误认。
          platformComment({
            commentId: "c-4",
            body: "成员留言",
            author: { id: "user-1", name: "张三", source: "aos" },
          }),
        ],
        nextCursor: null,
      }),
    );

    const created = await systemTicketsApi.createComment(PROJECT_ID, NUMBER, { body: "平台侧追问" }, "key-comment");
    if (!created.success || created.data === undefined || "status" in created.data) {
      throw new Error("发表评论未返回评论本体");
    }
    // 刚写入的那条：按 commentId 直接成立（作者 id 还没解析出来），作者名换成平台展示名。
    expect(isPlatformAuthoredComment(created.data.comment)).toBe(true);
    expect(toPlatformCommentView(created.data.comment, label).author.name).toBe(label);
    expect(platformAuditAuthorIdsSnapshot()).toEqual([]);

    const page = await systemTicketsApi.listComments(PROJECT_ID, NUMBER);
    if (!page.success || page.data === undefined) throw new Error("评论列表未返回");
    const [resolved, earlier, member] = page.data.items as unknown as [TicketComment, TicketComment, TicketComment];

    // 列表读过一次之后，审计主体 id 被认出来，同一主体此前的评论也一并归入。
    expect(platformAuditAuthorIdsSnapshot()).toEqual(["usr_system"]);
    expect(isPlatformAuthoredComment(resolved)).toBe(true);
    expect(isPlatformAuthoredComment(earlier)).toBe(true);
    expect(toPlatformCommentView(earlier, label).author.name).toBe(label);
    expect(toPlatformCommentView(earlier, label).author.source).toBe("aos");

    // 组织成员的评论：识别不动它，投影也原样返回同一个对象（调用方不需要分支）。
    expect(isPlatformAuthoredComment(member)).toBe(false);
    expect(toPlatformCommentView(member, label)).toBe(member);
    expect(member.author.name).toBe("张三");
  });
});
