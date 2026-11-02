// web/__tests__/cloud-drive-search-panel.test.tsx
// 搜索结果面板的运行时行为：同文件多片段合并为一行、命中词高亮、纯文本转义、片段截断与
// 加载 / 空 / 错误 / 重试 / 行内动作。数据源只有 props，不 mock 模块。
//
// 环境与 cloud-drive-page-states.test.tsx 相同：happy-dom + react-dom/client + 真实 i18next。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { ApiError } from "@fenix/web-runtime/api/request";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { CLOUD_DRIVE_NS, cloudDriveResources } from "../i18n";
import type {
  CloudDriveSearchFileResult,
  CloudDriveSearchResultPage,
  CloudDriveSearchSnippet,
} from "../types/cloud-drive";

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

const { CloudDriveSearchPanel } = await import("../components/cloud-drive/cloud-drive-search-panel");

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

function makeSnippet(
  text: string,
  query: string,
  leadingEllipsis = false,
  trailingEllipsis = false,
): CloudDriveSearchSnippet {
  const start = text.toLowerCase().indexOf(query.toLowerCase());
  return {
    text,
    matches: start >= 0 ? [{ start, end: start + query.length }] : [],
    leadingEllipsis,
    trailingEllipsis,
  };
}

function makeResult(overrides: Partial<CloudDriveSearchFileResult> = {}): CloudDriveSearchFileResult {
  const snippets = overrides.snippets ?? [makeSnippet("quarterly report content", "report")];
  return {
    fileId: "file-1",
    name: "季度报告.txt",
    path: "/工作/季度报告.txt",
    parentId: "dir-1",
    kind: "file",
    sizeBytes: 4096,
    updatedAt: "2026-10-28T10:00:00Z",
    snippets,
    matchCount: snippets.reduce((total, snippet) => total + snippet.matches.length, 0),
    location: { page: 1, block: null },
    completeness: { status: "ready", missingTextPages: [] },
    stale: false,
    currentVersionId: "version-1",
    returnedVersionId: "version-1",
    newerVersionStatus: null,
    snippet: snippets[0]?.text ?? "",
    ...overrides,
  };
}

function makePage(items: CloudDriveSearchFileResult[]): CloudDriveSearchResultPage {
  return {
    items,
    nextCursor: null,
    fileCount: items.length,
    matchCount: items.reduce((total, item) => total + item.matchCount, 0),
  };
}

interface PanelProps {
  term: string;
  results: CloudDriveSearchResultPage | undefined;
  loading: boolean;
  error: unknown;
  openingId: string | null;
  onClear: () => void;
  onRetry: () => void;
  onOpenLocation: (hit: CloudDriveSearchFileResult) => void;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
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
});

function renderPanel(overrides: Partial<PanelProps> = {}): PanelProps {
  const props: PanelProps = {
    term: "report",
    results: makePage([]),
    loading: false,
    error: null,
    openingId: null,
    onClear: () => undefined,
    onRetry: () => undefined,
    onOpenLocation: () => undefined,
    ...overrides,
  };
  act(() => {
    root.render(withI18n(createElement(CloudDriveSearchPanel, props)));
  });
  return props;
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

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if (button.getAttribute("aria-label") === label) return button as unknown as HTMLButtonElement;
  }
  return;
}

describe("云盘搜索结果面板", () => {
  // 业务意图：同一文件的多个片段只占一行，命中词用 <mark> 标出，头部给出文件与匹配数。
  test("同文件多片段聚合成一行并高亮命中词", () => {
    const result = makeResult({
      snippets: [makeSnippet("quarterly report content", "report"), makeSnippet("annual report summary", "report")],
    });
    renderPanel({ results: makePage([result]) });

    expect(container.querySelectorAll("li")).toHaveLength(1);
    const marks = [...container.querySelectorAll("mark")];
    expect(marks).toHaveLength(2);
    expect(marks.map((mark) => mark.textContent)).toEqual(["report", "report"]);
    expect(text()).toContain("About 1 files, 2 matches");
    expect(text()).toContain("季度报告.txt");
    expect(text()).toContain("Home / 工作");
  });

  // 业务意图：片段正文里的 HTML/脚本必须按纯文本渲染，不能被解释成 DOM。
  test("特殊字符按纯文本渲染，不产生脚本元素", () => {
    const result = makeResult({
      snippets: [makeSnippet('<script>alert("xss")</script> report', "report")],
    });
    renderPanel({ results: makePage([result]) });

    expect(container.querySelector("script")).toBeNull();
    expect(text()).toContain('<script>alert("xss")</script>');
    expect(container.querySelector("mark")?.textContent).toBe("report");
  });

  // 业务意图：三段片段合并进同一段并整体限制两行，避免同一文件把结果行撑成多段正文。
  test("三段片段合并为一段并限制两行", () => {
    const longText = `report ${"context ".repeat(80)}`;
    const result = makeResult({
      snippets: [makeSnippet(longText, "report"), makeSnippet(longText, "report"), makeSnippet(longText, "report")],
    });
    renderPanel({ results: makePage([result]) });

    const snippets = [...container.querySelectorAll("p.line-clamp-2")];
    expect(snippets).toHaveLength(1);
    expect(container.querySelectorAll("mark")).toHaveLength(3);
    expect(snippets[0]?.textContent?.split("·")).toHaveLength(3);
  });

  // 业务意图：无结果必须给独立空态与提示，而不是空白列表。
  test("空结果显示空态与提示", () => {
    renderPanel({ results: makePage([]) });

    expect(text()).toContain("No matching files");
    expect(text()).toContain("Try another keyword");
    expect(buttonByText("Clear search")).toBeDefined();
  });

  // 业务意图：搜索失败显示服务端 message，重试按钮真的触发回调。
  test("错误态显示服务端消息并可重试", () => {
    let retried = 0;
    renderPanel({
      results: undefined,
      error: new ApiError("upstream exploded", "CLOUD_DRIVE_UPSTREAM_ERROR"),
      onRetry: () => {
        retried += 1;
      },
    });

    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(text()).toContain("Could not load");
    expect(text()).toContain("upstream exploded");

    const retry = buttonByText("Retry");
    expect(retry).toBeDefined();
    act(() => {
      retry?.click();
    });
    expect(retried).toBe(1);
  });

  // 业务意图：请求在途时给可感知的加载态，不能先闪空态。
  test("加载态显示搜索中且不显示空态", () => {
    renderPanel({ results: undefined, loading: true });

    expect(text()).toContain("Searching…");
    expect(text()).not.toContain("No matching files");
  });

  // 业务意图：文件名与「打开所在目录」都回到目录；下载走同源内容地址。
  test("行内动作触发打开目录并提供下载链接", () => {
    const opened: string[] = [];
    const result = makeResult();
    renderPanel({
      results: makePage([result]),
      onOpenLocation: (hit) => opened.push(hit.fileId),
    });

    const nameButton = buttonByText("季度报告.txt");
    const folderButton = buttonByLabel("Go to folder");
    expect(nameButton).toBeDefined();
    expect(folderButton).toBeDefined();

    act(() => {
      nameButton?.click();
      folderButton?.click();
    });

    expect(opened).toEqual(["file-1", "file-1"]);
    const link = container.querySelector('a[href="/web/cloud-drive/files/file-1/content"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("aria-label")).toBe("Download");
  });
});
