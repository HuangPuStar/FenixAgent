// web/__tests__/admin-ticket-detail-page.test.tsx
// 管理台工单详情（`/admin/tickets` 内就地视图）的页面级用例：行打开、完整工单渲染、写动作、列表上下文保留、
// 401 回门与 i18n 插值。
//
// 钉住的是六件事，它们都只在运行时的状态流转里成立：
//   1. **行可打开详情**：点行内任意位置都进同一张详情，且详情的取数打到系统镜像端点（带 master key）；
//   2. **完整工单**：描述、状态、负责人、标签、附件、评论都在，归属坐标由列表行带过去（详情响应里没有它）；
//   3. **写动作走系统端点**：评论发表（重开后重新打开工单）打到 `/api/system/tickets/**` 并带 `Idempotency-Key`；
//   4. **列表上下文不丢**：详情是就地覆盖而不是路由切换，返回后仍在第 2 页且不重取第一页；
//   5. **401 清凭据回门**（详情侧的读数失败也要能回门，不是只在列表上判）；
//   6. **i18n 插值**：列表表头是「同步于」这个列名，详情里的「同步于 {{time}}」必须真的被插值（两侧都不许
//      出现 `{{…}}` 字面量——这正是列表表头曾复用带插值键所暴露的缺陷）；
//   7. **评论编辑**：管理面对**任意**评论开放编辑入口（不做原作者判定），保存打到镜像端点，失败保留草稿、取消
//      不发请求；平台写入的评论作者呈现为「平台系统管理员」，不沿用身份目录里的账号名，也不打「外部来源」角标。
//
// 不看弹窗（编辑 / 关闭确认）：Radix 覆盖层在 happy-dom 下不挂载（同进程内实测内容为空），弹窗内的写路径
// 由 `admin-ticket-write-actions.test.tsx` 以 hook 级用例覆盖。
//
// 环境：happy-dom + react-dom/client。**不用 `mock.module`**：react-i18next 用真实实例 + 本包真字典，
// `@fenix/ui-components` 用真实组件，唯一的外部数据源是 `fetch`（直接替换 `globalThis.fetch`）。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { clearAdminKey, getAdminKey, setAdminKey } from "@fenix/web-runtime/lib/admin-key";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { TICKETS_NS, ticketsResources } from "../i18n";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 与 `request()` 在模块加载/首次请求期需要 window / document / navigator。
const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/** 组件与请求栈依赖的 DOM 全局构造器；`afterAll` 逐条还原（本批测试与其它文件共享进程）。 */
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
  "HTMLFormElement",
  "HTMLImageElement",
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "PointerEvent",
  "ResizeObserver",
  "SVGElement",
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

/** 把 DOM 全局重新指向本用例的 window。 */
function applyDomGlobals(): void {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
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

/** 真实 i18next 实例：挂本包 zh 字典 + ui-components 的 zh 字典，与断言取的是同一份资源。 */
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

/** 期望文案一律取自字典本体，避免在断言里另抄一份中文。 */
const TEXT = ticketsResources.zh;

const ADMIN_KEY = "sys-key-admin-1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER = "7";

const LIST_PATH = "/api/system/tickets";
const DETAIL_PATH = `${LIST_PATH}/${PROJECT_ID}/${NUMBER}`;
const COMMENTS_PATH = `${DETAIL_PATH}/comments`;
const ATTACHMENTS_PATH = `${DETAIL_PATH}/attachments`;
const OPERATION_ID = "op-9";
const OPERATIONS_PATH = `/api/system/tickets/operations/${OPERATION_ID}`;

// 被测页面必须在注入 DOM 全局之后动态加载（其依赖链在模块求值期读全局 DOM）。
const { AdminTicketsPage } = await import("../pages/admin/AdminTicketsPage");

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown; binary?: boolean };
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

function jsonResponse({ status, body, binary }: StubResponse): Response {
  if (binary === true) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map([["content-type", "application/octet-stream"]]),
      blob: async () => new Blob([body as unknown as BlobPart]),
    } as unknown as Response;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map([["content-type", "application/json"]]),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 注册一条路由；同一 key 多次调用即排队（前一条用完后取后一条）。 */
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
/** 管理面列表行：`/web` 列表行的字段 + 归属坐标（坐标是服务端字段）。 */
function row(overrides: { issueNumber?: string; title?: string; organizationName?: string } = {}) {
  const issueNumber = overrides.issueNumber ?? NUMBER;
  return {
    issueNumber,
    title: overrides.title ?? `工单 ${issueNumber}`,
    state: "open",
    author: { id: "user-1", name: "张三", source: "aos" },
    assignee: null,
    labels: [],
    version: "v1",
    providerUpdatedAt: "2026-10-12T08:00:00.000Z",
    syncedAt: "2026-10-12T08:00:01.000Z",
    syncStatus: "ready",
    organizationId: "org-alpha",
    organizationName: overrides.organizationName ?? "阿尔法组织",
    projectId: PROJECT_ID,
    projectName: "alpha-repo",
    projectOwner: "aos-bot",
  };
}

/** 工单详情 DTO（与 `/web` 面同 schema，不含前端回填的 `projectId`）。 */
function ticketDto(overrides: Record<string, unknown> = {}) {
  return {
    issueNumber: NUMBER,
    title: "登录后跳转空白页",
    state: "open",
    author: { id: "user-1", name: "张三", source: "aos" },
    assignee: null,
    labels: [{ id: "label-1", name: "bug", color: "ff0000" }],
    version: "v1",
    providerUpdatedAt: "2026-10-12T08:00:00.000Z",
    syncedAt: "2026-10-12T08:00:01.000Z",
    syncStatus: "ready",
    body: "复现步骤：点击登录后页面空白。",
    pendingOperationId: null,
    ...overrides,
  };
}

function listPage(items: unknown[], options: { page?: number; total?: number } = {}): StubResponse {
  const page = options.page ?? 1;
  return ok({ items, total: options.total ?? items.length, page, pageSize: 20 });
}

function detailSuccess(overrides: Record<string, unknown> = {}): StubResponse {
  return ok({ ticket: ticketDto(overrides) });
}

/** 评论视图：`version` 是编辑时的 `expectedVersion`，`author.id` 为 null 即「归属未核验」。 */
function commentDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commentId: "c-1",
    issueNumber: NUMBER,
    body: "原始的评论内容",
    author: { id: "user-1", name: "张三", source: "aos" },
    version: "c1",
    providerUpdatedAt: "2026-10-12T09:00:00.000Z",
    ...overrides,
  };
}

function commentPage(items: unknown[]): StubResponse {
  return ok({ items, nextCursor: null });
}

/** 默认路由：列表一页 + 详情 + 空评论 + 空附件（各用例按需覆盖）。 */
function defaultRoutes(): void {
  routes = new Map();
  routeCalls = new Map();
  route("GET", LIST_PATH, listPage([row()]));
  route("GET", DETAIL_PATH, detailSuccess());
  route("GET", COMMENTS_PATH, ok({ items: [], nextCursor: null }));
  route("GET", ATTACHMENTS_PATH, ok({ items: [] }));
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  applyDomGlobals();
  win.sessionStorage.clear();
  setAdminKey(ADMIN_KEY);
  calls = [];
  defaultRoutes();
  restoreFetch = stubFetch();
  // 失败用例会经 `request()` 的失败日志与 hooks 的 onError 打屏：静音它们，避免错误输出淹没真正的诊断。
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

/** 挂载页面并等待取数落地（ahooks 的 promise 链跨多个微任务）。 */
async function renderPage(): Promise<void> {
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, createElement(AdminTicketsPage)));
  });
  await flush();
}

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 当前可见的视图：列表与详情同挂载，详情打开时列表被 `hidden` 覆盖（见页面文件头）。 */
function visibleView(): HTMLElement {
  for (const child of [...container.children]) {
    if (!(child as HTMLElement).hidden) return child as HTMLElement;
  }
  throw new Error("没有可见视图");
}

function text(): string {
  return visibleView().textContent ?? "";
}

function buttons(): HTMLButtonElement[] {
  return [...visibleView().querySelectorAll("button")] as unknown as HTMLButtonElement[];
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return buttons().find((button) => (button.textContent ?? "").trim() === label);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

/**
 * 向受控输入框输入文本。happy-dom 下 React 走「input 事件 polyfill」分支：`onChange` 只在**聚焦元素**的
 * keydown/keyup 上比对值变化，直接派发 `input` 或直接赋 `value` 都不会触发；而受控值又被 React 的值跟踪器
 * 比对，直接赋值会被判成「未变化」。因此按仓库既有做法用「聚焦 → 原型原生 setter 改值 → keydown」逼近
 * 真实键盘输入（口径见 `apps/web/src/__tests__/question-panel-custom-answer.test.tsx`）。
 */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
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

/**
 * 编辑态的输入框：长在「保存修改」按钮所在的评论行里。
 * **不能按文档顺序取第一个 textarea**——评论区顶部还有发表评论的输入框，取错了就会把草稿打进发表框。
 */
function editingTextarea(): HTMLTextAreaElement {
  const save = buttonByText(TEXT.comment.save);
  const editor = save?.closest("li")?.querySelector("textarea");
  if (editor === undefined || editor === null) throw new Error("编辑态未渲染输入框");
  return editor as unknown as HTMLTextAreaElement;
}

/** 发表评论的输入框：评论区顶部那个（不在任何评论行里）。 */
function composerTextarea(): HTMLTextAreaElement {
  const areas = [...visibleView().querySelectorAll("textarea")] as unknown as HTMLTextAreaElement[];
  const composer = areas.find((area) => area.closest("li") === null);
  if (composer === undefined) throw new Error("评论区未渲染发表输入框");
  return composer;
}

/** 在列表首行上点一下（点状态列而不是标题按钮：这是「整行可点」的那条路径）。 */
async function openRowFromList(index = 0): Promise<void> {
  const rows = [...visibleView().querySelectorAll("tbody tr")];
  const cells = [...(rows[index]?.querySelectorAll("td") ?? [])];
  const cell = cells[2];
  if (cell === undefined) throw new Error("列表未渲染可点的行");
  await click(cell as unknown as HTMLElement);
}

const requestsTo = (path: string): RecordedCall[] => calls.filter((call) => call.url.split("?")[0] === path);

describe("AdminTicketsPage 工单详情", () => {
  // 业务意图：管理面的行必须能点开详情，且详情的取数要打到系统镜像端点（带 master key）——详情响应里没有
  // 归属坐标，它只能由列表行带过去，所以这一屏同时钉住「坐标显示」与「请求面」。
  test("点列表行进详情：渲染完整工单与归属坐标，取数带 master key", async () => {
    await renderPage();
    await openRowFromList();

    const detailRequest = requestsTo(DETAIL_PATH)[0];
    expect(detailRequest?.authorization).toBe(`Bearer ${ADMIN_KEY}`);

    const body = text();
    expect(body).toContain(`#${NUMBER}`);
    expect(body).toContain(TEXT.detail.authorLabel);
    expect(body).toContain(TEXT.detail.labelsLabel);
    expect(body).toContain("bug");
    expect(body).toContain("复现步骤：点击登录后页面空白。");
    // 归属坐标来自列表行（详情响应里没有这两个字段）。
    expect(body).toContain("阿尔法组织");
    expect(body).toContain("aos-bot/alpha-repo");
    // 评论区与附件区都在（空态文案来自各自组件）。
    expect(body).toContain(TEXT.comment.sectionTitle);
    expect(body).toContain(TEXT.attachment.sectionTitle);
    // 详情打开后列表不可见（同挂载、被 `hidden` 覆盖），列表的标题按钮因此不出现在可见视图里。
    expect(visibleView().querySelectorAll("tbody tr").length).toBe(0);
  });

  // 业务意图：列表表头是**列名**，不能复用带插值的详情文案（`同步于 {{time}}` 没有可传的值，会把占位符
  // 原样印在列头上）；相邻的详情页则必须真的把 `{{time}}` 换成时间——两侧都不许出现 `{{…}}` 字面量。
  test("i18n 插值：列表表头是列名，详情的「同步于」带上了时间", async () => {
    await renderPage();

    const heads = [...visibleView().querySelectorAll("th")].map((head) => head.textContent?.trim());
    expect(heads.at(-1)).toBe(TEXT.admin.columnSyncedAt);
    expect(text()).not.toContain("{{");

    await openRowFromList();

    const synced = [...visibleView().querySelectorAll("p")]
      .map((paragraph) => paragraph.textContent ?? "")
      .find((line) => line.startsWith(TEXT.admin.columnSyncedAt));
    expect(synced).toBeDefined();
    expect(synced).not.toContain("{{time}}");
    expect((synced ?? "").length).toBeGreaterThan(TEXT.admin.columnSyncedAt.length);
  });

  // 业务意图：发表评论是管理面少数几个不需要覆盖层的写动作，它必须打到系统端点的评论镜像并带幂等键，
  // 成功后新评论立即出现在评论区（页面不再回源一次）。
  test("发表评论：POST 到系统镜像端点并出现在评论区", async () => {
    route(
      "POST",
      COMMENTS_PATH,
      ok(
        {
          comment: {
            commentId: "c-1",
            issueNumber: NUMBER,
            body: "已复现，正在排查。",
            author: { id: null, name: "平台运维", source: "external" },
            version: "v1",
            providerUpdatedAt: "2026-10-12T09:00:00.000Z",
          },
          operationId: "op-comment",
        },
        201,
      ),
    );
    await renderPage();
    await openRowFromList();

    const composer = composerTextarea();
    await typeInto(composer, "已复现，正在排查。");

    const submit = buttonByText(TEXT.comment.submit);
    if (submit === undefined) throw new Error("评论区未渲染发表按钮");
    await click(submit);

    const [request] = requestsTo(COMMENTS_PATH).filter((call) => call.method === "POST");
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(request?.idempotencyKey).toBeTruthy();
    expect(request?.body).toEqual({ body: "已复现，正在排查。" });
    expect(text()).toContain("已复现，正在排查。");
  });

  // 业务意图：重开是「无草稿的单值动作」，走工单镜像的 PATCH；成功后新视图就地替换页面数据，页头随之换回
  // 「关闭工单」——用户不需要手动刷新就能看到状态已经变了。
  test("重新打开：PATCH 系统镜像端点并就地更新页头", async () => {
    route("GET", DETAIL_PATH, detailSuccess({ state: "closed" }));
    route("PATCH", DETAIL_PATH, ok({ ticket: ticketDto({ state: "open", version: "v2" }), operationId: "op-open" }));
    await renderPage();
    await openRowFromList();

    const reopen = buttonByText(TEXT.action.reopen);
    if (reopen === undefined) throw new Error("页头未渲染重新打开按钮");
    await click(reopen);

    const [request] = requestsTo(DETAIL_PATH).filter((call) => call.method === "PATCH");
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(request?.body).toEqual({ state: "open", expectedVersion: "v1" });
    expect(buttonByText(TEXT.action.close)).toBeDefined();
  });

  // 业务意图：有待确认的写时，写入口必须整体禁用并给出横幅（服务端也会拒绝，界面提前告知）；「核对结果」
  // 走操作账本的镜像端点，结论为 uncertain 时横幅留在原地继续提示。
  test("待确认：横幅呈现、写入口禁用、核对结果走操作账本镜像", async () => {
    route("GET", DETAIL_PATH, detailSuccess({ pendingOperationId: OPERATION_ID }));
    route(
      "GET",
      OPERATIONS_PATH,
      ok({
        operation: {
          operationId: OPERATION_ID,
          kind: "issue.update",
          status: "uncertain",
          projectId: PROJECT_ID,
          targetId: NUMBER,
          result: null,
          createdAt: "2026-10-12T08:00:02.000Z",
          updatedAt: "2026-10-12T08:00:03.000Z",
        },
      }),
    );
    await renderPage();
    await openRowFromList();

    expect(text()).toContain(TEXT.write.uncertainTitle);
    expect(buttonByText(TEXT.action.edit)?.disabled).toBe(true);
    expect(buttonByText(TEXT.action.close)?.disabled).toBe(true);

    const resolve = buttonByText(TEXT.write.check);
    if (resolve === undefined) throw new Error("横幅未渲染核对按钮");
    await click(resolve);

    const [request] = requestsTo(OPERATIONS_PATH);
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(text()).toContain(TEXT.write.statusUncertain);
  });

  // 业务意图：详情失败是 401（凭据失效）时必须清掉 master key 并回门——在面板里显示「加载失败」会让人以为
  // 平台坏了；回门后 key 必须真的没了（否则下一次请求还会带着失效凭据）。
  test("详情 401：清凭据并回到密钥门", async () => {
    route("GET", DETAIL_PATH, fail(401, "UNAUTHORIZED", "凭据无效"));
    await renderPage();
    await openRowFromList();

    expect(getAdminKey()).toBeNull();
    expect(text()).toContain(TEXT.admin.gateTitle);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(TEXT.admin.gateAuthFailed);
  });

  // 业务意图：详情是同一路由内的就地覆盖而不是路由切换——返回列表后筛选与页码原样保留（连输入框里的
  // 关键词都还在），且不重取列表：重取会让用户在平台侧翻到第 3 页、筛过一轮时被弹回第一页。
  test("筛选与分页互动：筛过一轮、翻到第 2 页点开详情，返回后上下文原样且不重取列表", async () => {
    route(
      "GET",
      LIST_PATH,
      listPage([row({ issueNumber: "7", title: "第一页的工单" })], { total: 21, page: 1 }),
      listPage([row({ issueNumber: "3", title: "第二页的工单" })], { total: 21, page: 2 }),
    );
    route("GET", `${LIST_PATH}/${PROJECT_ID}/3`, ok({ ticket: ticketDto({ issueNumber: "3" }) }));
    await renderPage();

    const search = visibleView().querySelector("input");
    if (search === null) throw new Error("列表未渲染搜索框");
    await typeInto(search as unknown as HTMLInputElement, "空白页");
    const searchButton = buttonByText(TEXT.filter.searchLabel);
    if (searchButton === undefined) throw new Error("列表未渲染搜索按钮");
    await click(searchButton);
    expect(requestsTo(LIST_PATH)[1]?.url).toContain("q=");

    const next = buttonByText(TEXT.action.nextPage);
    if (next === undefined) throw new Error("列表未渲染下一页按钮");
    await click(next);
    expect(text()).toContain("第二页的工单");
    const listCallsBeforeDetail = requestsTo(LIST_PATH).length;

    await openRowFromList();
    expect(text()).toContain("#3");

    const back = buttonByText(TEXT.action.back);
    if (back === undefined) throw new Error("详情未渲染返回按钮");
    await click(back);

    expect(text()).toContain("第二页的工单");
    expect((visibleView().querySelector("input") as HTMLInputElement | null)?.value).toBe("空白页");
    expect(text()).toContain(
      TEXT.admin.pageIndicator.replace("{{page}}", "2").replace("{{totalPages}}", "2").replace("{{total}}", "21"),
    );
    expect(requestsTo(LIST_PATH).length).toBe(listCallsBeforeDetail);
  });

  // 业务意图：管理面没有会话主体，评论编辑入口因此**不能**照搬「只认作者本人」——服务端的管理面评论端点不做
  // 原作者判定（凭据即判据），照搬会让操作者改不了组织成员写的评论；保存走镜像的评论编辑端点，成功后正文
  // 就地替换、编辑态退出（页面不再回源一次）。
  test("评论编辑：对他人评论也开放入口，保存走镜像端点并就地替换", async () => {
    route("GET", COMMENTS_PATH, commentPage([commentDto()]));
    route(
      "PATCH",
      `${COMMENTS_PATH}/c-1`,
      ok({
        comment: commentDto({ body: "改后的评论内容", version: "c2" }),
        operationId: "op-comment-edit",
      }),
    );
    await renderPage();
    await openRowFromList();

    const editEntry = buttonByText(TEXT.comment.edit);
    if (editEntry === undefined) throw new Error("评论未渲染编辑入口");
    await click(editEntry);

    const editor = editingTextarea();
    expect(editor.value).toBe("原始的评论内容");

    await typeInto(editor, "改后的评论内容");
    const save = buttonByText(TEXT.comment.save);
    if (save === undefined) throw new Error("编辑态未渲染保存按钮");
    await click(save);

    const [request] = requestsTo(`${COMMENTS_PATH}/c-1`);
    expect(request?.method).toBe("PATCH");
    expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(request?.idempotencyKey).toBeTruthy();
    // 编辑带的是**这条评论自己的**版本（服务端按内容指纹比对），不是工单版本。
    expect(request?.body).toEqual({ body: "改后的评论内容", expectedVersion: "c1" });

    expect(text()).toContain("改后的评论内容");
    // 编辑态已退出：只剩下发表框那一个 textarea，保存按钮消失，编辑入口回到行内。
    expect(visibleView().querySelectorAll("textarea").length).toBe(1);
    expect(buttonByText(TEXT.comment.save)).toBeUndefined();
    expect(buttonByText(TEXT.comment.edit)).toBeDefined();
  });

  // 业务意图：写失败不能吞掉用户改到一半的内容——草稿与编辑态都要留着，直接再点一次保存即可（复用同一把
  // 幂等键）；取消则必须一个请求都不发。
  test("评论编辑失败保留草稿且可重试，取消不发请求", async () => {
    route("GET", COMMENTS_PATH, commentPage([commentDto()]));
    route(
      "PATCH",
      `${COMMENTS_PATH}/c-1`,
      fail(500, "INTERNAL_ERROR"),
      ok({ comment: commentDto({ body: "改后的评论内容", version: "c2" }), operationId: "op-comment-edit" }),
    );
    await renderPage();
    await openRowFromList();

    const editEntry = buttonByText(TEXT.comment.edit);
    if (editEntry === undefined) throw new Error("评论未渲染编辑入口");
    await click(editEntry);

    await typeInto(editingTextarea(), "改后的评论内容");

    const save = buttonByText(TEXT.comment.save);
    if (save === undefined) throw new Error("编辑态未渲染保存按钮");
    await click(save);

    // 草稿与编辑态都还在（失败不清输入），页面正文仍是服务端事实。
    expect(editingTextarea().value).toBe("改后的评论内容");
    expect(visibleView().querySelectorAll("textarea").length).toBe(2);

    // 取消：退出编辑态、回到服务端事实，且不再发任何写请求。
    const cancel = buttonByText(TEXT.comment.cancel);
    if (cancel === undefined) throw new Error("编辑态未渲染取消按钮");
    await click(cancel);
    expect(visibleView().querySelectorAll("textarea").length).toBe(1);
    expect(text()).toContain("原始的评论内容");

    const requestsBeforeRetry = requestsTo(`${COMMENTS_PATH}/c-1`).length;
    await click(editEntry);
    await typeInto(editingTextarea(), "改后的评论内容");
    const retrySave = buttonByText(TEXT.comment.save);
    if (retrySave === undefined) throw new Error("编辑态未渲染保存按钮");
    await click(retrySave);

    const patches = requestsTo(`${COMMENTS_PATH}/c-1`).filter((call) => call.method === "PATCH");
    expect(patches.length).toBe(requestsBeforeRetry + 1);
    expect(text()).toContain("改后的评论内容");
  });

  // 业务意图：平台写入的评论以**系统托管租户**为主体，身份目录里的名字是部署期的账号名。管理面必须如实呈现
  // 成「平台系统管理员」——不能把账号名当作者名显示（看起来像一个真实用户），也不能沿用组织成员的名称，
  // 更不能给操作者自己刚发的评论打上「外部来源／待核对」角标。
  test("平台写入的评论作者呈现为「平台系统管理员」，不沿用账号名与外部角标", async () => {
    route(
      "POST",
      COMMENTS_PATH,
      ok(
        {
          // 写响应里的作者恒为 external（服务端写入路径不回读刚落的归属行），名字是身份目录里的账号名。
          comment: commentDto({
            commentId: "c-9",
            body: "平台侧追问",
            author: { id: null, name: "admin", source: "external" },
          }),
          operationId: "op-comment",
        },
        201,
      ),
    );
    await renderPage();
    await openRowFromList();

    await typeInto(composerTextarea(), "平台侧追问");
    const submit = buttonByText(TEXT.comment.submit);
    if (submit === undefined) throw new Error("评论区未渲染发表按钮");
    await click(submit);

    const item = [...visibleView().querySelectorAll("li")].find((node) =>
      (node.textContent ?? "").includes("平台侧追问"),
    );
    expect(item).toBeDefined();
    expect(item?.textContent).toContain(TEXT.admin.platformAuthor);
    expect(item?.textContent).not.toContain("admin");
    expect(item?.textContent).not.toContain(TEXT.detail.externalAuthor);
  });

  // 业务意图：附件在管理面同样是工单级的、要能下载；下载必须带 `Authorization`（`<a>` / `<img>` 带不上），
  // 因此管理面不渲染缩略图预览——这条用例把「能下载 + 不预览」两件事一起钉住。
  test("附件：列表可用、下载带凭据、不渲染缩略图", async () => {
    route(
      "GET",
      ATTACHMENTS_PATH,
      ok({ items: [{ attachmentId: "8", name: "复现截图.png", size: 3, createdAt: "2026-10-12T08:30:00.000Z" }] }),
    );
    route("GET", `${ATTACHMENTS_PATH}/8`, { status: 200, body: new Uint8Array([1, 2, 3]), binary: true });
    const clicked: { href: string; download: string }[] = [];
    const originalClick = win.HTMLAnchorElement.prototype.click;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    win.HTMLAnchorElement.prototype.click = function clickStub(this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    };
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    try {
      await renderPage();
      await openRowFromList();

      expect(text()).toContain("复现截图.png");
      // 管理面不渲染缩略图：图源需要可内联的地址，而这里的凭据是请求头。
      expect(visibleView().querySelector("img")).toBeNull();

      const download = buttonByText(TEXT.attachment.download);
      if (download === undefined) throw new Error("附件行未渲染下载按钮");
      await click(download);

      const [request] = requestsTo(`${ATTACHMENTS_PATH}/8`);
      expect(request?.authorization).toBe(`Bearer ${ADMIN_KEY}`);
      expect(clicked).toEqual([{ href: "blob:test", download: "复现截图.png" }]);
    } finally {
      win.HTMLAnchorElement.prototype.click = originalClick;
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });
});
