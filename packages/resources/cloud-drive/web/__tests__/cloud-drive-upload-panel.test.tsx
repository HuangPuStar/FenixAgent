// web/__tests__/cloud-drive-upload-panel.test.tsx
// 上传浮层的可见性规则：有任务才显示、全部完成后自动隐藏、失败保持、关闭/清除立即隐藏、
// 新任务重新出现、进度更新不会让已关闭的浮层复活。
//
// 这些规则由组件内部状态机决定，读源码断言不到；用 happy-dom + 假定时器把每个分支跑一遍。
// 不 mock 模块：i18n 用真实实例并挂本包字典，按钮文案与断言同源。

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { CloudDriveUploadTask } from "../hooks/use-cloud-drive-uploads";
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

const { CloudDriveUploadPanel, UPLOAD_AUTO_HIDE_DELAY_MS } = await import(
  "../components/cloud-drive/cloud-drive-upload-panel"
);

const TEXT = cloudDriveResources.en;

const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: CLOUD_DRIVE_NS,
  initAsync: false,
  resources: { en: { [CLOUD_DRIVE_NS]: cloudDriveResources.en } },
});

/** 构造一条任务；默认是上传中，按用例覆盖状态。 */
function task(overrides: Partial<CloudDriveUploadTask> & Pick<CloudDriveUploadTask, "id">): CloudDriveUploadTask {
  return {
    name: "report.pdf",
    sizeBytes: 100,
    uploadedBytes: 0,
    status: "uploading",
    message: null,
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;
let clearFinishedCalls: number;

function render(tasks: readonly CloudDriveUploadTask[]): void {
  const panel: ReactElement = createElement(CloudDriveUploadPanel, {
    tasks,
    onRetry: () => {},
    onCancel: () => {},
    onClearFinished: () => {
      clearFinishedCalls += 1;
    },
  });
  act(() => {
    root.render(createElement(I18nextProvider, { i18n }, panel));
  });
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

function closeButton(): HTMLButtonElement | undefined {
  const button = container.querySelector(`button[aria-label="${TEXT.upload.close}"]`);
  return (button as unknown as HTMLButtonElement | null) ?? undefined;
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  clearFinishedCalls = 0;
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
  jest.useRealTimers();
});

describe("上传浮层的可见性", () => {
  // 业务意图：没有任务时不占右下角，避免空卡片遮挡页面。
  test("空队列不渲染任何内容", () => {
    render([]);
    expect(text()).toBe("");
  });

  // 业务意图：有进行中任务时显示为右下角浮层，并沿用原有进度条与状态文案。
  test("有进行中任务时显示固定定位浮层", () => {
    render([task({ id: "upload-1", uploadedBytes: 50 })]);

    const section = container.querySelector("section");
    expect(section?.className).toContain("fixed");
    expect(section?.className).toContain("bottom-4");
    expect(section?.className).toContain("right-4");
    expect(section?.className).toContain("z-50");
    expect(text()).toContain(TEXT.upload.title);
    expect(text()).toContain("report.pdf");
    expect(text()).toContain("Uploading 50%");
  });

  // 业务意图：全部完成后保留 2 秒让用户看到结果，再自动收起；隐藏后不残留空节点。
  test("全部完成后 2 秒自动隐藏", () => {
    render([task({ id: "upload-1", status: "done", uploadedBytes: 100 })]);

    expect(text()).toContain(TEXT.upload.done);

    advance(UPLOAD_AUTO_HIDE_DELAY_MS - 1);
    expect(text()).toContain(TEXT.upload.title);

    advance(1);
    expect(text()).toBe("");
  });

  // 业务意图：失败条目必须一直可见（可重试），不能被自动隐藏计时器吞掉。
  test("失败条目保持可见且自动隐藏计时器不生效", () => {
    render([task({ id: "upload-1", status: "error", message: "quota exceeded" })]);

    advance(UPLOAD_AUTO_HIDE_DELAY_MS * 5);

    expect(text()).toContain(TEXT.upload.title);
    expect(text()).toContain(TEXT.upload.failed);
    expect(text()).toContain("quota exceeded");
  });

  // 业务意图：关闭按钮立即隐藏，即使仍有进行中的上传；用户已明确表达不想看这块浮层。
  test("关闭按钮立即隐藏", () => {
    render([task({ id: "upload-1" })]);

    const close = closeButton();
    expect(close).toBeDefined();
    act(() => close?.click());

    expect(text()).toBe("");
  });

  // 业务意图：「清除已完成」立即隐藏浮层，并把清理动作交给队列 owner。
  test("清除已完成立即隐藏并通知调用方", () => {
    render([task({ id: "upload-1", status: "done", uploadedBytes: 100 })]);

    act(() => buttonByText(TEXT.upload.clearFinished)?.click());

    expect(clearFinishedCalls).toBe(1);
    expect(text()).toBe("");
  });

  // 业务意图：自动隐藏后，新上传必须重新出现；否则用户看不到新任务的进度。
  test("自动隐藏后出现新任务时重新显示", () => {
    render([task({ id: "upload-1", status: "done", uploadedBytes: 100 })]);
    advance(UPLOAD_AUTO_HIDE_DELAY_MS);
    expect(text()).toBe("");

    render([
      task({ id: "upload-1", status: "done", uploadedBytes: 100 }),
      task({ id: "upload-2", name: "photo.png", status: "queued" }),
    ]);

    expect(text()).toContain(TEXT.upload.title);
    expect(text()).toContain("photo.png");
  });

  // 业务意图：关闭浮层后，同一条任务的进度更新不能把它重新弹出来——只有新任务才可以。
  test("已关闭时同一任务的进度更新不会重新显示", () => {
    render([task({ id: "upload-1", uploadedBytes: 10 })]);
    act(() => closeButton()?.click());
    expect(text()).toBe("");

    render([task({ id: "upload-1", uploadedBytes: 60 })]);
    expect(text()).toBe("");
  });
});
