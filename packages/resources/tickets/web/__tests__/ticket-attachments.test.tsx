// web/__tests__/ticket-attachments.test.tsx
// 附件的前端行为用例（计划 §200 的组合规则 + §326 的验收口径：10 MiB 可传、超限拒绝、取消能释放流）。
//
// 覆盖三件事，每件都对应一条只有附件才有的前端事实：
//   1. 预检在**选文件那一刻**完成（超限/空文件/超额逐条给出，不入队、不发请求、不占幂等键）；
//   2. 上传是「一次动作一批文件」——每次最多 5 个由前端拆请求，并发上限 2 由队列调度，202 交给详情页的
//      待确认横幅（不重发：重发只会让账本多一条在途）；
//   3. 下载必须经本服务代理端点（响应里没有上游地址），因此断言的是「请求打到本服务路径」。
//
// 环境与既有前端用例一致：happy-dom + 真 i18n 字典 + 真路由 + fetch 桩（不 mock 模块）。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { OrgSessionProvider } from "@fenix/web-runtime/contexts/org-session";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { TICKETS_NS, ticketsResources } from "../i18n";
import { planTicketAttachmentSelection } from "../lib/ticket-attachment-limits";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

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
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLTextAreaElement",
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

const TEXT = ticketsResources.zh;

/** 被测页面必须在注入 DOM 全局之后动态加载（依赖链里有 streamdown，模块求值期读全局 DOM）。 */
const { AgentTicketDetailPage } = await import("../pages/agent-panel/pages/AgentTicketDetailPage");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER = "42";
const ORG_SESSION = { organizationId: "org-1", userId: "user-1", isOwner: false, pending: false };

let detailProps: { projectId: string; number: string } = { projectId: PROJECT_ID, number: NUMBER };

function DetailPageRoute() {
  return createElement(AgentTicketDetailPage, detailProps);
}

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };
type UploadCall = { idempotencyKey: string | null; fileName: string; fileSize: number };

let detailCalls = 0;
let listCalls = 0;
let uploadCalls: UploadCall[] = [];
let downloadCalls: string[] = [];
let detailResponses: StubResponse[] = [];
let attachmentListResponses: StubResponse[] = [];
/** 上传响应队列；返回函数时按「挂起」处理，由用例手动放行（并发上限用例需要观察在飞数量）。 */
let uploadResponses: (StubResponse | (() => Promise<StubResponse>))[] = [];
let downloadResponse: StubResponse = { status: 200, body: new Uint8Array([1, 2, 3]) };
let inFlightUploads = 0;
let peakInFlightUploads = 0;

function attachmentsPath(): string {
  return `/web/tickets/${PROJECT_ID}/${NUMBER}/attachments`;
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

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    // 附件路径必须先判：它与详情、评论共享前缀，落到后面那条会拿详情响应当附件。
    if (url.startsWith(attachmentsPath())) {
      const rest = url.slice(attachmentsPath().length);
      if (method === "POST") {
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        uploadCalls.push({
          idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
          fileName: file.name,
          fileSize: file.size,
        });
        inFlightUploads += 1;
        peakInFlightUploads = Math.max(peakInFlightUploads, inFlightUploads);
        const next = uploadResponses[Math.min(uploadCalls.length - 1, uploadResponses.length - 1)];
        try {
          if (typeof next === "function") return jsonResponse(await next());
          if (next === undefined) throw new Error("fetch 桩收到未配置的上传请求");
          return jsonResponse(next);
        } finally {
          inFlightUploads -= 1;
        }
      }
      if (rest === "") {
        const response = attachmentListResponses[Math.min(listCalls, attachmentListResponses.length - 1)];
        listCalls += 1;
        if (response === undefined) throw new Error("fetch 桩收到未配置的附件列表请求");
        return jsonResponse(response);
      }
      downloadCalls.push(url);
      return new Response(downloadResponse.body as BodyInit, { status: downloadResponse.status });
    }
    if (url.startsWith(`/web/tickets/${PROJECT_ID}/${NUMBER}/comments`)) {
      return jsonResponse({ status: 200, body: { success: true, data: { items: [], nextCursor: null } } });
    }
    if (!url.startsWith(`/web/tickets/${PROJECT_ID}/${NUMBER}`)) throw new Error(`未预期的请求：${method} ${url}`);
    const response = detailResponses[Math.min(detailCalls, detailResponses.length - 1)];
    detailCalls += 1;
    if (response === undefined) throw new Error("fetch 桩收到未配置的详情请求");
    return jsonResponse(response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function failure(code: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message: "boom" } } };
}

function detailSuccess(): StubResponse {
  return {
    status: 200,
    body: {
      success: true,
      data: {
        ticket: {
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
        },
      },
    },
  };
}

function attachment(attachmentId: string, name: string, size: number): Record<string, unknown> {
  return { attachmentId, name, size, createdAt: "2026-10-12T09:00:00.000Z" };
}

function attachmentPage(items: unknown[]): StubResponse {
  return { status: 200, body: { success: true, data: { items } } };
}

function uploadSuccess(record: Record<string, unknown>): StubResponse {
  return { status: 201, body: { success: true, data: { attachment: record, operationId: "op-attach" } } };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

function createTestRouter() {
  const rootRoute = createRootRoute();
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent/tickets",
    component: () => createElement("div", null, "list-route"),
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent/tickets/$projectId/$number",
    component: DetailPageRoute,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [`/agent/tickets/${PROJECT_ID}/${NUMBER}`] }),
    isServer: true,
  });
}

beforeEach(() => {
  applyDomGlobals();
  detailCalls = 0;
  listCalls = 0;
  uploadCalls = [];
  downloadCalls = [];
  uploadResponses = [];
  inFlightUploads = 0;
  peakInFlightUploads = 0;
  detailProps = { projectId: PROJECT_ID, number: NUMBER };
  detailResponses = [detailSuccess()];
  attachmentListResponses = [attachmentPage([])];
  downloadResponse = { status: 200, body: new Uint8Array([1, 2, 3]) };
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

async function renderDetail(): Promise<void> {
  const router = createTestRouter();
  await router.load();
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(
      <OrgSessionProvider value={ORG_SESSION}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </OrgSessionProvider>,
    );
  });
  await flush();
}

function text(): string {
  return container.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as HTMLButtonElement;
  }
  return;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await flush();
}

function fileInput(): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (input === null) throw new Error("附件控件未渲染出文件输入");
  return input as unknown as HTMLInputElement;
}

/** 给文件输入挂上一批文件并派发 change：happy-dom 里 `files` 是只读的，只能在实例上覆盖。 */
async function selectFiles(files: File[]): Promise<void> {
  const input = fileInput();
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
  });
  await flush();
}

/** 小体积夹具：内容不影响断言，用最小字节数避免造 10 MiB 的内存。 */
function fileOf(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

/** 求值形如 `10 * 1024 * 1024` 的乘积表达式（只用于与后端常量对齐的那条断言）。 */
function parseProduct(expression: string): number {
  return expression.split("*").reduce((product, part) => product * Number(part.trim().replace(/_/g, "")), 1);
}

describe("附件预检（选文件那一刻的本地判定）", () => {
  // 超限、空文件与超额各有各的文案：把三种情况合成一句「有文件不合法」，用户不知道该改哪一个文件。
  test("逐文件给出拒绝原因，只有合法文件进队列", () => {
    const ok = fileOf("ok.png", 4);
    const plan = planTicketAttachmentSelection([ok, fileOf("empty.png", 0), fileOf("huge.png", 10 * 1024 * 1024 + 1)]);

    expect(plan.accepted).toEqual([ok]);
    expect(plan.rejected.map((item) => item.reason)).toEqual(["empty", "tooLarge"]);
  });

  // 「每次最多 5 个」是每次选择的组合规则：第 6 个及之后被拒，前 5 个照常入队（不是整批退回）。
  test("一次选择超过 5 个时只收前 5 个，其余标为超额", () => {
    const files = Array.from({ length: 7 }, (_, index) => fileOf(`f${index}.png`, 8));
    const plan = planTicketAttachmentSelection(files);

    expect(plan.accepted.length).toBe(5);
    expect(plan.rejected.length).toBe(2);
    expect(plan.rejected.every((item) => item.reason === "tooMany")).toBe(true);
  });

  // 常量必须与后端同源：前端预检比后端宽松会让用户白等一次必然失败的往返，比后端严格会挡掉合法文件。
  test("上限常量与后端 ticket-limits 的数值一致", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "..", "..", "src", "server", "services", "ticket-limits.ts"),
      "utf8",
    );
    const backendMax = /TICKET_ATTACHMENT_MAX_BYTES\s*=\s*([^;]+);/.exec(source)?.[1];
    const backendCount = /TICKET_ATTACHMENT_MAX_COUNT\s*=\s*([^;]+);/.exec(source)?.[1];

    // 后端上限写成 `10 * 1024 * 1024` 的乘积式，按 `*` 求值即可（只用于这一条对齐断言）。
    expect(parseProduct(backendMax ?? "")).toBe(10 * 1024 * 1024);
    expect(Number(backendCount?.trim())).toBe(5);
    expect(planTicketAttachmentSelection([fileOf("edge.png", 10 * 1024 * 1024)]).rejected).toEqual([]);
  });
});

describe("附件上传（页面级）", () => {
  // 选中文件即上传：multipart 字段名 file、文件名原样带出、幂等键在头里，成功后新附件出现在列表。
  test("选中文件后发出 multipart 请求并前插到附件列表", async () => {
    uploadResponses = [uploadSuccess(attachment("8", "复现截图.png", 4))];
    await renderDetail();

    await selectFiles([fileOf("复现截图.png", 4)]);

    expect(uploadCalls.length).toBe(1);
    expect(uploadCalls[0]?.fileName).toBe("复现截图.png");
    expect(uploadCalls[0]?.fileSize).toBe(4);
    expect(uploadCalls[0]?.idempotencyKey).toBeTruthy();
    expect(text()).toContain("复现截图.png");
    expect(text()).toContain(TEXT.attachment.sectionTitle);
  });

  // 并发上限 2：一次选 5 个文件时，同时在飞的请求最多 2 个（其余排队），全部完成后上传请求恰好 5 次。
  test("并发上限：同时在飞的上传请求不超过 2 个", async () => {
    const release: (() => void)[] = [];
    uploadResponses = [
      () =>
        new Promise<StubResponse>((resolveResponse) => {
          release.push(() => resolveResponse(uploadSuccess(attachment("8", "a.png", 8))));
        }),
    ];
    await renderDetail();

    await selectFiles(Array.from({ length: 5 }, (_, index) => fileOf(`f${index}.png`, 8)));
    expect(uploadCalls.length).toBe(2);
    expect(peakInFlightUploads).toBe(2);

    // 逐个放行直到队列清空：每完成一个，队列补一个，全程在飞数量保持 2（并发上限靠「完成一个补一个」维持）。
    for (let round = 0; round < 5; round += 1) {
      await act(async () => {
        release.splice(0).forEach((fn) => {
          fn();
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush(2);
    }
    expect(peakInFlightUploads).toBe(2);
    expect(uploadCalls.length).toBe(5);
  });

  // 超限文件在本地就被拒：不发请求、不占幂等键，toast 直接给出原因。
  test("超限文件被本地拒绝且不产生任何上传请求", async () => {
    await renderDetail();

    await selectFiles([fileOf("huge.png", 10 * 1024 * 1024 + 1)]);

    expect(uploadCalls).toEqual([]);
    expect(text()).not.toContain("huge.png");
  });

  // 202：远端结果未定 → 详情页挂出待确认横幅，且**不重发**（重发只会让账本多一条在途）。
  test("上传返回 202 时进入待确认态且不重发", async () => {
    uploadResponses = [
      { status: 202, body: { success: true, data: { operationId: "op-uncertain", status: "uncertain" } } },
    ];
    detailResponses = [detailSuccess(), detailSuccess()];
    await renderDetail();

    await selectFiles([fileOf("慢文件.png", 4)]);

    expect(uploadCalls.length).toBe(1);
    expect(text()).toContain(TEXT.write.uncertainTitle);
  });

  // 失败留在队列里可重试：重试必须复用同一把幂等键（换键会把第一次可能已落库的写入再写一份）。
  test("上传失败保留失败行，重试复用同一把幂等键", async () => {
    uploadResponses = [failure("TICKETS_PAUSED", 503), uploadSuccess(attachment("9", "重试.png", 4))];
    await renderDetail();

    await selectFiles([fileOf("重试.png", 4)]);
    expect(text()).toContain(TEXT.attachment.retry);

    const retry = buttonByText(TEXT.attachment.retry);
    if (retry === undefined) throw new Error("失败行未渲染重试按钮");
    await click(retry);

    expect(uploadCalls.length).toBe(2);
    expect(uploadCalls[1]?.idempotencyKey).toBe(uploadCalls[0]?.idempotencyKey);
    expect(text()).toContain("重试.png");
  });

  // 列表回源失败不退化成空列表：错误分支给重试入口（空列表会让用户以为附件被删了）。
  test("附件列表失败显示错误与重试，点重试重新请求", async () => {
    attachmentListResponses = [failure("GIT_UNAVAILABLE", 503), attachmentPage([attachment("8", "a.png", 4)])];
    await renderDetail();

    expect(text()).toContain(TEXT.attachment.loadFailed);

    const retry = buttonByText(TEXT.loadState.retry);
    if (retry === undefined) throw new Error("附件区未渲染重试按钮");
    await click(retry);

    expect(listCalls).toBe(2);
    expect(text()).toContain("a.png");
  });
});

describe("附件下载", () => {
  // 下载必须打到本服务的代理端点（上游地址带服务账号凭据，响应里也不含它），并触发浏览器保存。
  test("点下载请求本服务代理端点并落盘为原文件名", async () => {
    attachmentListResponses = [attachmentPage([attachment("8", "复现截图.png", 3)])];
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
      await renderDetail();

      const download = buttonByText(TEXT.attachment.download);
      if (download === undefined) throw new Error("附件行未渲染下载按钮");
      await click(download);

      expect(downloadCalls).toEqual([`${attachmentsPath()}/8`]);
      expect(clicked.length).toBe(1);
      expect(clicked[0]?.download).toBe("复现截图.png");
      expect(clicked[0]?.href).toBe("blob:test");
    } finally {
      win.HTMLAnchorElement.prototype.click = originalClick;
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });
});

describe("图片预览", () => {
  // 列表视图没有 MIME，只有扩展名可判：图片名给缩略图并直接指向本服务的下载端点（同源、走会话 cookie），
  // 非图片名不渲染缩略图（判定说错的两种情况都退回普通文件行，下载按钮始终还在）。
  test("图片名渲染指向下载端点的缩略图，非图片名不渲染", async () => {
    attachmentListResponses = [
      attachmentPage([attachment("8", "复现截图.PNG", 3), attachment("9", "运行日志.txt", 4)]),
    ];
    await renderDetail();

    const thumbs = container.querySelectorAll(`button[aria-label="${TEXT.attachment.preview}"]`);
    expect(thumbs.length).toBe(1);
    const image = thumbs[0]?.querySelector("img");
    expect(image?.getAttribute("src")).toBe(`${attachmentsPath()}/8`);
    expect(image?.getAttribute("alt")).toBe("复现截图.PNG");
    expect(text()).toContain("运行日志.txt");
  });
});

describe("粘贴图片（评论框）", () => {
  /** 构造剪贴板替身：happy-dom 无真实 DataTransfer，粘贴只消费 `files` / `items` 两个入口。 */
  function clipboardOf(files: File[], options: { itemsOnly?: boolean } = {}): DataTransfer {
    const items = files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }));
    return { files: options.itemsOnly ? [] : files, items } as unknown as DataTransfer;
  }

  /** 在评论输入框上派发一次粘贴；返回事件以便断言是否被拦截（`defaultPrevented`）。 */
  function paste(clipboard: DataTransfer): Event {
    const textarea = container.querySelector("textarea");
    if (textarea === null) throw new Error("评论框未渲染 textarea");
    const event = new win.ClipboardEvent("paste", { bubbles: true, cancelable: true });
    // happy-dom 的 ClipboardEvent init 不接受外部 DataTransfer，直接挂属性：React 以
    // `"clipboardData" in event` 判定后原样取用（见 react-dom 的 clipboardData 分支）。
    Object.defineProperty(event, "clipboardData", { value: clipboard, configurable: true });
    textarea.dispatchEvent(event as unknown as Event);
    return event as unknown as Event;
  }

  // 粘贴截图走与「添加附件」同一条队列；图片只在 `items` 里的来源（从网页复制图片、部分截图工具）也要识别，
  // 并换成带时间戳的唯一名——恢复核对按「文件名 + 字节数」认领结果，默认的 image.png 重名会让它转人工。
  test("剪贴板图片（files 为空、只在 items 里）入队上传并换成唯一名", async () => {
    uploadResponses = [uploadSuccess(attachment("9", "pasted-image.png", 4))];
    await renderDetail();

    await act(async () => {
      paste(clipboardOf([fileOf("image.png", 4)], { itemsOnly: true }));
    });
    await flush();

    expect(uploadCalls.length).toBe(1);
    expect(uploadCalls[0]?.fileName).toMatch(/^pasted-image-\d{8}-\d{6}-\d+-[a-z0-9]{6}\.png$/);
    expect(uploadCalls[0]?.fileSize).toBe(4);
  });

  // 纯文本粘贴必须保持浏览器默认行为：拦截它会让「往评论里粘一段文字」彻底失效（本 hook 也拿文字没办法）。
  test("纯文本粘贴不拦截、不入队", async () => {
    await renderDetail();

    let event: Event | undefined;
    await act(async () => {
      event = paste({ files: [], items: [] } as unknown as DataTransfer);
    });

    expect(event?.defaultPrevented).toBe(false);
    expect(uploadCalls).toEqual([]);
  });
});
