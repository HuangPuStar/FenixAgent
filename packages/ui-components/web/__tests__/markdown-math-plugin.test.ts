// web/__tests__/markdown-math-plugin.test.ts
// markdown 数学渲染插件的契约测试（2026-10-15 文档预览批次）。
//
// 为什么必须有：这条链路是「复用既有预览器 + 二次加工」——插件把自己挂在 `textPlugin` 之后，
// 对**它渲染出来的 DOM**做 KaTeX 自动渲染。两处都容易假成功：插件名匹配不对（markdown 走不到这里）、
// 或扫描范围不对（把代码块里的 `$` 当公式）。用例直接跑真实插件 + 真实 markdown 渲染，断言 DOM。
//
// happy-dom：viewport 是游离节点（不挂进 document），预览器只为它建子树，不涉及布局。
// DOM 全局注入比 `preview-fetch-injection.test.ts` 多几个：markdown 分支里的 Prism 在模块求值期
// 直接读全局 `Element` / `Node`（只给 window + document 会在 `Element.prototype.matches` 处 ReferenceError），
// `HTMLElement` 与 `customElements` 仍按 §11.2 成对注入，避免把「有 DOM、没有注册表」泄漏给后续文件。
// `compatMode` 由 `initializeHappyDomWindow` 补齐：KaTeX 在模块求值期据此判定 quirks 模式，
// 缺了它 KaTeX 的 DOM 渲染会被换成抛错的桩，自动渲染整条失效（失败点会飘到本文件之外）。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import type { PreviewPlugin } from "@open-file-viewer/core";
import { Window } from "happy-dom";

const win = initializeHappyDomWindow(new Window());
const globalScope = globalThis as Record<string, unknown>;
globalScope.window = win;
globalScope.document = win.document;
globalScope.navigator = win.navigator;
globalScope.Element = win.Element;
globalScope.Node = win.Node;
globalScope.HTMLElement = win.HTMLElement;
globalScope.customElements = win.customElements;

// **求值顺序是断言成立的前提**：`@open-file-viewer/core` 的 bundle 里有静态
// `import DOMPurify from "dompurify"`，而 DOMPurify 在模块求值期读全局 `window`。`bun test` 的 preload 会把
// `window` 垫成 `globalThis`（无 `document`），若在注入 happy-dom 之前求值，DOMPurify 会退回
// 「不支持」形态（`sanitize` 为 undefined），markdown 渲染链路整条失效。因此这里用动态导入，
// 把求值顺序钉在注入之后（同 `preview-source.test.ts` 的写法）。
const { markdownMathPlugin } = await import("../components/preview/markdown-math-plugin");

/** 用真实插件渲染一段 markdown，返回承载它的游离节点。 */
async function renderMarkdown(markdown: string, extension = "md"): Promise<HTMLDivElement> {
  const viewport = win.document.createElement("div") as unknown as HTMLDivElement;
  const plugin = markdownMathPlugin();
  const ctx = {
    viewport,
    file: { source: new Blob([markdown]), name: `a.${extension}`, extension, mimeType: "text/markdown" },
    // 预览器在 markdown 分支里会按 `ctx.options.zoom` 建缩放控制器：这里给最小可用的一份
    options: { zoom: 1, fit: "width", fallback: "inline", messages: {} },
    setLoading: () => {},
    setError: (message: string) => {
      throw new Error(`预览器报错：${message}`);
    },
  };
  // 不调 `instance.destroy()`：markdown 分支的 destroy 会把渲染出来的容器摘掉，
  // 断言必须发生在它之前（游离节点由用例自己回收）。
  await plugin.render(ctx as unknown as Parameters<PreviewPlugin["render"]>[0]);
  return viewport;
}

describe("markdown 数学渲染插件", () => {
  // 只有认领 markdown 扩展名才会走这条链路；否则插件形同虚设而用例仍会「通过」
  test("只匹配 markdown 扩展名", () => {
    const plugin = markdownMathPlugin();
    const file = (extension: string) => ({ extension }) as Parameters<PreviewPlugin["match"]>[0];

    expect(plugin.match(file("md"))).toBe(true);
    expect(plugin.match(file("markdown"))).toBe(true);
    expect(plugin.match(file("txt"))).toBe(false);
    expect(plugin.match(file("tex"))).toBe(false);
  });

  // 行内 `$…$` 与行间 `$$…$$` 都要落到 KaTeX 节点：这是本批次要补的能力
  test("行内与行间公式渲染为 KaTeX 节点", async () => {
    const viewport = await renderMarkdown("Inline $a^2 + b^2$ end.\n\n$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$\n");

    expect(viewport.querySelectorAll(".katex").length).toBe(2);
    // 行间公式用 KaTeX 的 display 形态渲染
    expect(viewport.querySelector(".katex-display")).not.toBeNull();
    // 原文里的定界符不该残留
    expect(viewport.textContent ?? "").not.toContain("$$");
  });

  // 代码块里的 `$` 是示例代码，不是公式（KaTeX 默认忽略 pre/code）
  test("代码块中的美元符号不参与公式渲染", async () => {
    const viewport = await renderMarkdown("```js\nconst price = $5;\n```\n");

    expect(viewport.querySelectorAll(".katex").length).toBe(0);
    expect(viewport.textContent ?? "").toContain("const price = $5;");
  });

  // KaTeX 不支持的宏必须留下可见内容而不是崩掉整篇预览：`throwOnError:false` 下 KaTeX 把无法解析的宏
  // 按错误色（红）就地渲染，公式节点仍在、后续正文照常渲染（不做本地化提示：这段 DOM 由预览器生成，
  // 插件拿不到 React 上下文，KaTeX 自身的错误色即是给用户的提示）
  test("不支持的宏按错误色就地渲染，不抛异常", async () => {
    const viewport = await renderMarkdown("Broken $\\notarealmacro{x}$ end.\n");

    expect(viewport.querySelectorAll(".katex").length).toBe(1);
    expect(viewport.innerHTML).toContain("#cc0000");
    expect(viewport.textContent ?? "").toContain("\\notarealmacro");
    expect(viewport.textContent ?? "").toContain("end.");
  });

  // 结构渲染仍走既有预览器：加了数学渲染之后 markdown 的块级结构不能丢
  test("markdown 结构渲染保持原样", async () => {
    const viewport = await renderMarkdown("# Title\n\n## Section\n\n- one\n- two\n");

    // 不断言 h1：happy-dom 的 DOM 下 DOMPurify 会丢掉 h1 元素（真实浏览器不会），
    // 结构断言改用能存活下来的 h2 / 列表
    expect(viewport.querySelector("h2")?.textContent).toBe("Section");
    expect(viewport.querySelectorAll("li").length).toBe(2);
    expect(viewport.textContent ?? "").toContain("Title");
  });
});
