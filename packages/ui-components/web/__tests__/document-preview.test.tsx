// web/__tests__/document-preview.test.tsx
// 文档类预览（markdown / `.tex`）容器的状态边界与 LaTeX 渲染的降级契约（2026-10-15 文档预览批次）。
//
// 覆盖的是用户真正会看到的东西：空文件、超出字节上限、渲染 / 源码切换，以及 KaTeX 认不出的宏
// 是否留在原位（不白屏、不丢内容）。解析层自己的用例在 `latex-document.test.ts`。
//
// 渲染走 happy-dom：`LaTeX` 渲染只用 `katex.renderToString`（纯字符串产物，不依赖真实布局），
// 因此在 happy-dom 里可以完整断言；需要 DOM 测量的 `katex.render` 不在这条路径上。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import { DocumentPreview } from "../components/preview/DocumentPreview";
import { PREVIEW_MAX_DOCUMENT_BYTES } from "../components/preview/preview-source";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.HTMLElement = win.HTMLElement;
globals.customElements = win.customElements;
globals.IS_REACT_ACT_ENVIRONMENT = true;

// **求值顺序**：`FileViewerPreview` 会静态拉进 `@open-file-viewer/core`，而该 bundle 静态导入的
// DOMPurify 在模块求值期读全局 `window`——`bun test` 的 preload 把 `window` 垫成没有 `document` 的
// `globalThis`，在注入 happy-dom 之前求值会让它退回「不支持」形态（`sanitize` 为 undefined），
// 并污染同进程后续所有走 markdown 渲染的用例。因此这份导入放在注入之后（同 `markdown-math-plugin.test.ts`）。
const { FileViewerPreview } = await import("../components/preview/FileViewerPreview");

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/** 断言用的文案直接取字典：改词条不该让用例失效，改键名才会 */
const T = en.fileTree.preview;

const mounted: Root[] = [];

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  win.document.body.replaceChildren();
});

/** 用文档容器建一棵树；返回承载它的宿主节点。 */
function mount(props: { kind: "markdown" | "latex"; blob: Blob; markdownView?: ReactNode }): HTMLElement {
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <DocumentPreview kind={props.kind} blob={props.blob} markdownView={props.markdownView ?? null} />
      </I18nextProvider>,
    );
  });
  return host;
}

/** 逐个事件循环推进，让惰性模块（KaTeX 渲染层）与解码 effect 落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 等某个标记出现再断言：LaTeX 渲染层是动态导入的，同步渲染只能拿到 Suspense 兜底。 */
async function waitFor(host: HTMLElement, selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = host.querySelector(selector);
    if (found) return found;
    await flush();
  }
  throw new Error(`等待 ${selector} 超时（惰性模块未落地）`);
}

/** 点标签按钮（渲染 / 源码）。 */
async function clickTab(host: HTMLElement, label: string): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!button) throw new Error(`找不到按钮：${label}`);
  await act(async () => {
    button.click();
  });
}

const markdownBlob = (text: string) => new Blob([text], { type: "text/markdown" });

describe("文档预览 — 状态边界", () => {
  // 空文件在解码前就能判定（0 字节），应给明确空态而不是空白面板
  test("0 字节文件显示空态", async () => {
    const host = mount({ kind: "markdown", blob: new Blob([]) });

    expect(host.textContent).toContain(T.emptyFile);
    expect(host.querySelector("pre")).toBeNull();
  });

  // 超过字节上限只提供源码展示，并禁用渲染标签：整篇同步解析会让面板长时间无响应
  test("超出字节上限只展示源码并禁用渲染标签", async () => {
    const host = mount({
      kind: "markdown",
      blob: new Blob([new Uint8Array(PREVIEW_MAX_DOCUMENT_BYTES + 1)]),
      markdownView: <p>不应出现</p>,
    });

    expect(host.textContent).toContain(T.tooLarge);
    const renderTab = [...host.querySelectorAll("button")].find((item) => item.textContent === T.renderTab);
    expect(renderTab?.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).not.toContain("不应出现");
    await waitFor(host, "pre");
  });

  // markdown 的渲染模式复用宿主传入的既有预览器（含数学插件的 FileViewer），容器只负责挂载它
  test("markdown 渲染模式挂载既有预览器", async () => {
    const host = mount({
      kind: "markdown",
      blob: markdownBlob("# Title"),
      markdownView: <p>既有预览器</p>,
    });

    expect(host.textContent).toContain("既有预览器");
  });

  // 源码模式展示的是解码后的正文：markdown 与 LaTeX 共用同一条回退路径
  test("markdown 源码模式展示原文", async () => {
    const host = mount({
      kind: "markdown",
      blob: markdownBlob("# Title\n\nInline $a^2$.\n"),
      markdownView: <p>既有预览器</p>,
    });

    await clickTab(host, T.sourceTab);
    const source = await waitFor(host, "pre");

    expect(source.textContent).toContain("$a^2$");
    expect(host.textContent).not.toContain("既有预览器");
  });
});

describe("LaTeX 预览 — 渲染与降级", () => {
  // 结构与公式都要出现在 DOM 里：这是 `.tex` 预览存在的前提
  test("章节与公式渲染为 DOM（KaTeX 节点）", async () => {
    const host = mount({
      kind: "latex",
      blob: markdownBlob("\\section{Intro}\n\nInline $a^2 + b^2$.\n"),
    });

    await waitFor(host, ".katex");
    expect(host.textContent).toContain("Intro");
    expect(host.querySelector(".katex")?.textContent ?? "").not.toBe("");
  });

  // KaTeX 认不出的宏不得白屏：公式留在原位（KaTeX 错误态），旁边补一条本地化提示
  test("不支持的宏就地渲染并给出提示", async () => {
    const host = mount({
      kind: "latex",
      blob: markdownBlob("\\section{Broken}\n\n$\\notarealmacro{x}$\n"),
    });

    await waitFor(host, ".katex");

    expect(host.querySelector(".katex")?.innerHTML).toContain("#cc0000");
    expect(host.textContent).toContain(T.mathUnsupported);
    // 出错的只有那一条公式，章节与其它内容仍要渲染
    expect(host.textContent).toContain("Broken");
  });

  // LaTeX 源码模式与 markdown 同一条路径：降级展示原文，不再走渲染
  test("LaTeX 源码模式展示原文", async () => {
    const host = mount({ kind: "latex", blob: markdownBlob("\\section{Intro}\n") });

    await clickTab(host, T.sourceTab);
    const source = await waitFor(host, "pre");

    expect(source.textContent).toContain("\\section{Intro}");
    expect(host.querySelector(".katex")).toBeNull();
  });
});

describe("预览器接线 — `.tex` 走文档分支", () => {
  // 接线（分类 → 分流 → 取字节 → 文档容器）是这条链路里最容易「看起来实现了但没接上」的一段：
  // 用例从 `FileViewerPreview` 入口走完整条路径，断言 KaTeX 节点真的出现在预览面板里。
  test("tex 路径经取数注入后渲染出公式", async () => {
    const host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
    const root = createRoot(host);
    mounted.push(root);
    const source = "\\section{Wired}\n\n$c^2$\n";
    const fetchPreview = async () => new Response(source, { headers: { "Content-Type": "text/plain" } });

    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <FileViewerPreview
            envId="env-1"
            filePath="user/paper.tex"
            buildPreviewUrl={(envId, filePath) => `/preview/${envId}/${filePath}`}
            fetchPreview={fetchPreview}
          />
        </I18nextProvider>,
      );
    });

    await waitFor(host, ".katex");
    expect(host.textContent).toContain("Wired");
  });
});
