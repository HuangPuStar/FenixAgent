// web/__tests__/cloud-drive-preview-panel.test.tsx
// 预览面板的运行时行为：转换中提示、栅格页图（版本号必须进 URL）、翻页、不支持类型与 413 错误态。
//
// 环境与 cloud-drive-page-states.test.tsx 相同：happy-dom + react-dom/client + 真实 i18next；
// 数据源只有 `globalThis.fetch` 一处，不 mock 模块。
//
// markdown 渲染由 ui-components 的 MessageResponse（streamdown 惰性加载）承担，happy-dom 下不做结构
// 断言——markdown 的取数与分页规则在 cloud-drive-preview-logic.test.ts 覆盖。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { CLOUD_DRIVE_NS, cloudDriveResources } from "../i18n";
import type { CloudDriveFile } from "../types/cloud-drive";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

const { CloudDrivePreviewPanel } = await import("../components/cloud-drive/cloud-drive-preview-panel");

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

const FILE_URL = "/web/cloud-drive/files/file-1";
const PREVIEW_URL = "/web/cloud-drive/files/file-1/preview";

type StubResponse = { status: number; body: unknown };

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

function makeFile(name: string, conversionStatus: string | null = "ready"): CloudDriveFile {
  return {
    id: "file-1",
    parentId: null,
    name,
    path: `/${name}`,
    kind: "file",
    lifecycle: "active",
    sizeBytes: 4096,
    contentType: "application/octet-stream",
    currentVersionId: "version-1",
    metadataRevision: 1,
    createdAt: null,
    updatedAt: "2026-10-28T10:00:00Z",
    conversion: conversionStatus ? { status: conversionStatus, errorCode: null, completeness: null } : null,
  };
}

function success<T>(data: T): StubResponse {
  return { status: 200, body: { success: true, data } };
}

function failure(code: string, message: string, status = 500): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

let metadataResponse: StubResponse;
let previewResponse: StubResponse;
let previewCalls = 0;
let restoreFetch: () => void;
let container: HTMLElement;
let root: Root;

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url === FILE_URL) return jsonResponse(metadataResponse);
    if (method === "GET" && url === PREVIEW_URL) {
      previewCalls += 1;
      return jsonResponse(previewResponse);
    }
    throw new Error(`用例未登记的请求：${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

beforeEach(() => {
  metadataResponse = success(makeFile("text.pdf"));
  previewResponse = success({ versionId: "version-7", pageCount: 2, pages: [1, 2], conversionStatus: "ready" });
  previewCalls = 0;
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
});

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(file: CloudDriveFile): Promise<void> {
  act(() => {
    root.render(withI18n(createElement(CloudDrivePreviewPanel, { file })));
  });
  await settle();
}

function text(): string {
  return container.textContent ?? "";
}

function byAriaLabel(label: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="${label}"]`);
}

function buttonByText(label: string): HTMLButtonElement | null {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
  }
  return null;
}

describe("云盘预览面板", () => {
  // 栅格预览必须用清单里的版本号拼页图 URL；缺 versionId 上游会直接 404。
  test("PDF 页图 URL 带版本号并可翻页", async () => {
    await render(makeFile("text.pdf"));

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/web/cloud-drive/files/file-1/preview/pages/1?versionId=version-7");

    const next = byAriaLabel("Next page");
    expect(next).not.toBeNull();
    await act(async () => {
      next?.click();
    });
    await settle();

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/web/cloud-drive/files/file-1/preview/pages/2?versionId=version-7",
    );
    expect(text()).toContain("/ 2");
  });

  // 转换中显示进度态，不请求 markdown/页清单（否则只会拿到必然的 404）。
  test("queued/processing 显示转换进度且不取内容", async () => {
    metadataResponse = success(makeFile("report.docx", "processing"));
    await render(makeFile("report.docx", "processing"));

    expect(text()).toContain("Converting the file…");
    expect(previewCalls).toBe(0);
  });

  // 不支持的类型不发预览请求，只给下载出口。
  test("不支持的类型提示下载", async () => {
    metadataResponse = success(makeFile("archive.zip"));
    await render(makeFile("archive.zip"));

    expect(text()).toContain("Preview is not supported for this type");
    expect(previewCalls).toBe(0);
    expect(container.querySelector('a[href="/web/cloud-drive/files/file-1/content"]')).not.toBeNull();
  });

  // 413 是确定性失败：展示服务端文案与下载入口，不提供原地重试。
  test("413 展示服务端文案且不提供重试", async () => {
    metadataResponse = success(makeFile("text.pdf"));
    previewResponse = failure("CLOUD_DRIVE_PAYLOAD_TOO_LARGE", "File too large to preview", 413);
    await render(makeFile("text.pdf"));

    expect(text()).toContain("File too large to preview");
    expect(text()).toContain("Preview unavailable");
    expect(buttonByText("Retry")).toBeNull();
    expect(container.querySelector('a[href="/web/cloud-drive/files/file-1/content"]')).not.toBeNull();
  });

  // 未就绪的 404 会先进入轮询（处理态），而不是把「文件不存在」直接甩给用户。
  test("未就绪 404 进入转换轮询态", async () => {
    metadataResponse = success(makeFile("scan.png", "ready"));
    previewResponse = failure("CLOUD_DRIVE_PREVIEW_NOT_READY", "文件尚未转换完成", 404);
    await render(makeFile("scan.png"));

    expect(text()).toContain("Converting the file…");
  });

  // 转换失败（failed）时提供「重新转换」入口，走 conversions 端点。
  test("转换失败提供重新转换入口", async () => {
    metadataResponse = success(makeFile("scan.png", "failed"));
    previewResponse = failure("CLOUD_DRIVE_PREVIEW_FAILED", "文件无法转换为可预览内容", 422);
    await render(makeFile("scan.png", "failed"));

    expect(text()).toContain("文件无法转换为可预览内容");
    expect(text()).toContain("Convert again");
  });
});
