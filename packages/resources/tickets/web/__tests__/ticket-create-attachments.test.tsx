// web/__tests__/ticket-create-attachments.test.tsx
// 新建弹窗附件能力的前端契约（2026-10：与详情页一致的图片粘贴 + 附件选择）。
//
// 覆盖一个入口与两段编排：
//   1. 描述框粘贴（`TicketCreateFields`）：图片换成唯一名进入暂存，纯文本保持浏览器默认行为；
//   2. 暂存列表（`useTicketStagedAttachments`）：选入即预检、超限/空文件当场拒绝且不入列、可逐项移除；
//   3. 上传移交（`useTicketUploadHandoff`）：以工单号为坐标挂载即上传、跨批累积时分批入队、全部终结才
//      回调一次；失败不阻断出口——重试 / 移除 / 202 三条终结路径各有用例。
//
// 为什么是组件/hook 级而不是弹窗级：弹窗外壳是 Radix Dialog，覆盖层在同进程全量运行时不挂载（见
// agent-ticket-write-actions.test.tsx 文件头），而这段逻辑的核心是时序与请求构造，不是像素。
// 环境与既有前端用例一致：happy-dom + 真 i18n 字典 + fetch 桩（不 mock 模块）。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FormProvider, useForm } from "react-hook-form";
import { I18nextProvider } from "react-i18next";

import { useTicketStagedAttachments, useTicketUploadHandoff } from "../hooks/use-ticket-create-attachments";
import { TICKETS_NS, ticketsResources } from "../i18n";
import { TICKET_ATTACHMENT_MAX_BYTES, TICKET_ATTACHMENT_MAX_COUNT } from "../lib/ticket-attachment-limits";

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
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "PointerEvent",
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

/** 被测组件必须在注入 DOM 全局之后动态加载（依赖链里的组件库在模块求值期读全局 DOM）。 */
const { TicketCreateFields } = await import("../pages/agent-panel/components/ticket-create-dialog");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const NUMBER = "42";
const ATTACHMENTS_PATH = `/web/tickets/${PROJECT_ID}/${NUMBER}/attachments`;

// ── fetch 桩：只服务附件上传端点，其余路径一律抛错（请求打错坐标会当场暴露，而不是被吞掉） ──
type StubResponse = { status: number; body: unknown };
type UploadCall = { idempotencyKey: string | null; fileName: string; fileSize: number; path: string };

let uploadCalls: UploadCall[] = [];
/** 上传响应队列；不足时重复使用最后一条（批量用例据此只配一条成功响应）。 */
let uploadResponses: StubResponse[] = [];
let finishCount = 0;

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
    if (url !== ATTACHMENTS_PATH || method !== "POST") throw new Error(`未预期的请求：${method} ${url}`);
    const form = init.body as FormData;
    const file = form.get("file") as File;
    uploadCalls.push({
      idempotencyKey: new Headers(init.headers).get("idempotency-key"),
      fileName: file.name,
      fileSize: file.size,
      path: url,
    });
    const next = uploadResponses[Math.min(uploadCalls.length - 1, uploadResponses.length - 1)];
    if (next === undefined) throw new Error("fetch 桩收到未配置的上传请求");
    return jsonResponse(next);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function uploadSuccess(name: string, size: number): StubResponse {
  return {
    status: 201,
    body: {
      success: true,
      data: { attachment: { attachmentId: "9", name, size, createdAt: null }, operationId: "op-1" },
    },
  };
}

function uploadFailure(): StubResponse {
  return { status: 500, body: { success: false, error: { code: "UPSTREAM_UNAVAILABLE", message: "boom" } } };
}

function uploadAccepted(): StubResponse {
  return { status: 202, body: { success: true, data: { operationId: "op-uncertain", status: "uncertain" } } };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;

beforeEach(() => {
  applyDomGlobals();
  uploadCalls = [];
  uploadResponses = [];
  finishCount = 0;
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

async function render(element: ReactElement): Promise<void> {
  act(() => {
    root = createRoot(container);
  });
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n }, element));
  });
  await flush();
}

function text(id: string): string {
  return container.querySelector(`#${id}`)?.textContent ?? "";
}

async function click(selector: string): Promise<void> {
  const button = container.querySelector(selector);
  if (button === null) throw new Error(`未找到按钮：${selector}`);
  await act(async () => {
    (button as HTMLButtonElement).click();
  });
  await flush();
}

/** 小体积夹具：内容不影响断言，用最小字节数避免造 10 MiB 的内存（同 `ticket-attachments.test.tsx`）。 */
function fileOf(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

// ── 被测组件的驱动面 ──

/** 暂存列表探针：按钮触发选入/移除，`#staged` 输出当前文件名。 */
function StagedProbe(): ReactElement {
  const staged = useTicketStagedAttachments();
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { id: "add-files", onClick: () => staged.addFiles([fileOf("shot.png", 4), fileOf("log.txt", 8)]) },
      "add",
    ),
    createElement(
      "button",
      { id: "add-oversize", onClick: () => staged.addFiles([fileOf("big.png", TICKET_ATTACHMENT_MAX_BYTES + 1)]) },
      "add-big",
    ),
    createElement("pre", { id: "staged" }, staged.staged.map((item) => item.file.name).join("|")),
    ...staged.staged.map((item) =>
      createElement(
        "button",
        { key: item.id, "data-remove": item.file.name, onClick: () => staged.removeFile(item.id) },
        "remove",
      ),
    ),
  );
}

/** 上传移交探针：`#queue` 输出任务状态，逐任务暴露重试/移除按钮。 */
function HandoffProbe({ files, onFinished }: { files: File[]; onFinished: () => void }): ReactElement {
  const handoff = useTicketUploadHandoff({ files, number: NUMBER, onFinished, projectId: PROJECT_ID });
  return createElement(
    "div",
    null,
    createElement("pre", { id: "queue" }, handoff.uploads.map((task) => `${task.name}:${task.status}`).join("|")),
    ...handoff.uploads.map((task) =>
      createElement(
        "span",
        { key: task.id },
        createElement(
          "button",
          { "data-act": `retry:${task.name}`, onClick: () => handoff.retryUpload(task.id) },
          "retry",
        ),
        createElement(
          "button",
          { "data-act": `remove:${task.name}`, onClick: () => handoff.removeUpload(task.id) },
          "remove",
        ),
      ),
    ),
  );
}

/** 描述框探针：渲染字段块（含 form Provider），由粘贴用例派发真实 paste 事件。 */
function FieldsProbe(): ReactElement {
  const staged = useTicketStagedAttachments();
  const form = useForm<{ title: string; body: string }>({ defaultValues: { title: "", body: "" } });
  return createElement(
    FormProvider,
    { ...form },
    createElement(TicketCreateFields, {
      disabled: false,
      onAddFiles: staged.addFiles,
      onRemoveFile: staged.removeFile,
      staged: staged.staged,
    }),
    createElement("pre", { id: "staged" }, staged.staged.map((item) => item.file.name).join("|")),
  );
}

/** 构造剪贴板替身：happy-dom 无真实 DataTransfer，粘贴只消费 `files` / `items` 两个入口。 */
function clipboardOf(files: File[], options: { itemsOnly?: boolean } = {}): DataTransfer {
  const items = files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }));
  return { files: options.itemsOnly ? [] : files, items } as unknown as DataTransfer;
}

/** 在描述框上派发一次粘贴；返回事件以便断言是否被拦截（`defaultPrevented`）。 */
function pasteOnTextarea(clipboard: DataTransfer): Event {
  const textarea = container.querySelector("textarea");
  if (textarea === null) throw new Error("描述框未渲染 textarea");
  const event = new win.ClipboardEvent("paste", { bubbles: true, cancelable: true });
  // happy-dom 的 ClipboardEvent init 不接受外部 DataTransfer，直接挂属性：React 以
  // `"clipboardData" in event` 判定后原样取用（见 react-dom 的 clipboardData 分支）。
  Object.defineProperty(event, "clipboardData", { value: clipboard, configurable: true });
  textarea.dispatchEvent(event as unknown as Event);
  return event as unknown as Event;
}

const onFinished = (): void => {
  finishCount += 1;
};

describe("描述框粘贴（新建弹窗）", () => {
  // 粘贴的截图走与「添加附件」同一个暂存列表；图片只在 `items` 里的来源（从网页复制图片、部分截图工具）
  // 也要识别，并换成带时间戳的唯一名——恢复核对按「文件名 + 字节数」认领结果，默认的 image.png 重名会
  // 让它转人工。
  test("剪贴板图片（files 为空、只在 items 里）换成唯一名进入暂存并拦截默认粘贴", async () => {
    await render(createElement(FieldsProbe));

    let event: Event | undefined;
    await act(async () => {
      event = pasteOnTextarea(clipboardOf([fileOf("image.png", 4)], { itemsOnly: true }));
    });
    await flush();

    expect(event?.defaultPrevented).toBe(true);
    expect(text("staged")).toMatch(/^pasted-image-\d{8}-\d{6}-\d+-[a-z0-9]{6}\.png$/);
  });

  // 纯文本粘贴必须保持浏览器默认行为：拦截它会让「往描述里粘一段文字」彻底失效。
  test("纯文本粘贴不拦截、不入列", async () => {
    await render(createElement(FieldsProbe));

    let event: Event | undefined;
    await act(async () => {
      event = pasteOnTextarea({ files: [], items: [] } as unknown as DataTransfer);
    });

    expect(event?.defaultPrevented).toBe(false);
    expect(text("staged")).toBe("");
  });
});

describe("暂存列表（表单阶段）", () => {
  // 暂存列表是「工单创建后自动上传」的可见凭据：选入即入列（含非图片文件——类型白名单由托管平台裁决），
  // 超限文件被拒且不入列（拒绝文案由 toast 给出，这里断言的是它没有混进列表）。
  test("选入的文件累积进暂存列表，超限文件被拒且不入列", async () => {
    await render(createElement(StagedProbe));

    await click("#add-files");
    expect(text("staged")).toBe("shot.png|log.txt");

    await click("#add-oversize");
    expect(text("staged")).toBe("shot.png|log.txt");
  });

  // 移除只影响目标项：待上传列表在创建前是用户唯一的更正手段（移除 = 放弃该文件，不产生任何请求）。
  test("逐项移除只影响目标文件", async () => {
    await render(createElement(StagedProbe));

    await click("#add-files");
    await click('[data-remove="shot.png"]');

    expect(text("staged")).toBe("log.txt");
    expect(uploadCalls).toEqual([]);
  });
});

describe("上传移交（创建成功后）", () => {
  // 挂载即以新工单坐标为每一个暂存文件发一次上传（一次用户动作一批文件、一次远端写一个请求），
  // 全部成功后回调且只回调一次——上传完成是弹窗关闭并进入工单的唯一前提。
  test("挂载即按工单坐标上传暂存文件，全部成功后回调一次", async () => {
    uploadResponses = [uploadSuccess("shot.png", 4)];
    await render(createElement(HandoffProbe, { files: [fileOf("shot.png", 4)], onFinished }));

    expect(uploadCalls.length).toBe(1);
    expect(uploadCalls[0]?.path).toBe(ATTACHMENTS_PATH);
    expect(uploadCalls[0]?.fileName).toBe("shot.png");
    expect(uploadCalls[0]?.fileSize).toBe(4);
    expect(uploadCalls[0]?.idempotencyKey).toBeTruthy();
    expect(finishCount).toBe(1);

    await flush();
    expect(finishCount).toBe(1);
  });

  // 暂存可以跨多次选择累积，而预检的名额是「每次选择」的组合规则：超过单批上限时必须拆批移交，
  // 否则第 6 个文件会被预检拒绝、用户以为传了却少一个。
  test("暂存超过单批上限时分批入队，全部送达后才回调", async () => {
    uploadResponses = [uploadSuccess("shot.png", 4)];
    const files = Array.from({ length: TICKET_ATTACHMENT_MAX_COUNT + 1 }, (_, index) => fileOf(`shot-${index}.png`, 4));
    await render(createElement(HandoffProbe, { files, onFinished }));

    expect(uploadCalls.length).toBe(TICKET_ATTACHMENT_MAX_COUNT + 1);
    expect(finishCount).toBe(1);
  });

  // 失败不阻断出口但也不自动完成：任务留在队列里等用户决定（重试复用同一把幂等键——重发同内容必须
  // 命中服务端的原操作，否则第一次超时但已落库的上传会被重写一份，用户看到两个同名附件）。
  test("失败的任务不触发完成，重试复用同一把幂等键且成功后完成", async () => {
    uploadResponses = [uploadFailure(), uploadSuccess("shot.png", 4)];
    await render(createElement(HandoffProbe, { files: [fileOf("shot.png", 4)], onFinished }));

    expect(text("queue")).toBe("shot.png:failed");
    expect(finishCount).toBe(0);

    await click('[data-act="retry:shot.png"]');

    expect(uploadCalls.length).toBe(2);
    expect(uploadCalls[1]?.idempotencyKey).toBe(uploadCalls[0]?.idempotencyKey);
    expect(finishCount).toBe(1);
  });

  // 放弃失败项（移除）后队列空，完成判定接管——「前往工单」按钮走的正是这条路径，不过它多播一次循环。
  test("失败项被移除后队列清空并完成", async () => {
    uploadResponses = [uploadFailure()];
    await render(createElement(HandoffProbe, { files: [fileOf("shot.png", 4)], onFinished }));

    expect(finishCount).toBe(0);

    await click('[data-act="remove:shot.png"]');

    expect(text("queue")).toBe("");
    expect(finishCount).toBe(1);
  });

  // 202 受理与成功同样是「终结」：任务移出队列（重发只会让账本多一条在途），用户由 toast 得知
  // 「结果确认中」，弹窗继续走完流程而不是把工单拦在上传阶段。
  test("202 受理视为终结：任务移出队列并完成", async () => {
    uploadResponses = [uploadAccepted()];
    await render(createElement(HandoffProbe, { files: [fileOf("shot.png", 4)], onFinished }));

    expect(text("queue")).toBe("");
    expect(finishCount).toBe(1);
  });

  // 防御：正常路径不会以空文件集渲染本阶段（弹窗在无暂存附件时走原有跳转），但误用不应造成死等。
  test("没有暂存文件时立即完成", async () => {
    await render(createElement(HandoffProbe, { files: [], onFinished }));

    expect(uploadCalls).toEqual([]);
    expect(finishCount).toBe(1);
  });
});
