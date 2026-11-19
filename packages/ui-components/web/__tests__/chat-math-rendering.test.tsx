// web/__tests__/chat-math-rendering.test.tsx
// 聊天正文的数学渲染契约（2026-10-15 数学渲染批次，接入 `@streamdown/math`）。
//
// 为什么必须有：聊天正文的数学不是我们自己渲染的——插件注册在 `MESSAGE_PLUGINS`，解析由 remark-math、
// 渲染由 rehype-katex 承担，任何一环没接上，界面上只会安静地把 `$x^2$` 当普通文本显示（不报错）。
// 用例直接渲染 `MessageResponse`（生产路径：streamdown 惰性边界 + 插件常量），断言 DOM 里真的出现
// KaTeX 节点；另覆盖「坏公式不得吞掉正文」的降级与代码围栏内的 `$`（否则公式会把示例代码吃掉）。
//
// happy-dom：rehype-katex 走 `katex.renderToString`（字符串产物，不依赖布局），因此可完整断言。
// 骨架沿用本包既有的聊天用例（`message-bubble-copy.test.tsx`）。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
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

const mounted: Root[] = [];

afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  win.document.body.replaceChildren();
});

/** 逐个事件循环推进，让惰性模块（streamdown、KaTeX、样式表）落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 等标记出现再断言：正文渲染器是动态导入的，同步渲染只能拿到兜底内容。 */
async function waitFor(host: HTMLElement, selector: string): Promise<Element> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const found = host.querySelector(selector);
    if (found) return found;
    await flush();
  }
  throw new Error(`等待 ${selector} 超时（惰性模块未落地）`);
}

/** 渲染一条助手正文（生产路径：`MessageResponse` → 惰性 streamdown + `MESSAGE_PLUGINS`）。 */
async function renderMessage(
  markdown: string,
  mode: "static" | "streaming" = "static",
  isStreaming = false,
): Promise<HTMLElement> {
  const { MessageResponse } = await import("../chat/primitives/message");
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <MessageResponse mode={mode} isStreaming={isStreaming}>
          {markdown}
        </MessageResponse>
      </I18nextProvider>,
    );
  });
  return host;
}

describe("聊天正文的数学渲染", () => {
  // 截图中的编号公式需要 display 模式，同行双美元不能被降成行内公式。
  test.each([
    ["静态消息", "static", false],
    ["流式结束", "streaming", false],
    ["流式生成中", "streaming", true],
  ] as const)("%s 中同行编号公式保留公式与编号", async (_name, mode, isStreaming) => {
    const formulas = [
      String.raw`H(\Theta\mid Y)\;\le\;H(P_e)+P_e\log(M-1)\;\le\;\log 2+P_e\log M. \tag{2.1}`,
      String.raw`P_e\;\ge\;1-\frac{I(\Theta;Y)+\log 2}{\log M}. \tag{2.2}`,
      String.raw`\min_{i\neq j}d(\theta_i,\theta_j)\ge 2\delta. \tag{4.1}`,
      String.raw`I(\Theta;Y)\;\le\;\frac{1}{M^2}\sum_{i,j}\mathrm{KL}(P_i\|P_j). \tag{4.2}`,
      String.raw`\boxed{\;\inf_{\hat\theta}\sup_\theta\mathbb E_\theta[d]\;\ge\;\delta\Big(1-\frac{\frac{1}{M^2}\sum_{i,j}\mathrm{KL}(P_i\|P_j)+\log 2}{\log M}\Big).\;} \tag{4.3}`,
      String.raw`(x_0-p)\cdot(x-p)\le 0\qquad\text{对所有 }x\in\mathcal C. \tag{1}`,
    ];
    const host = await renderMessage(
      formulas.map((formula) => `**定理** $$${formula}$$ 后续说明。`).join("\n\n"),
      mode,
      isStreaming,
    );

    await waitFor(host, ".katex, .katex-error");

    expect(host.querySelectorAll(".katex-error").length).toBe(0);
    expect(host.querySelectorAll(".katex-display").length).toBe(6);
    expect([...host.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(formulas);
    expect(host.querySelectorAll(".tag").length).toBe(6);
    expect(host.textContent).toContain("后续说明。");
  });

  // 开头环境不能被当作 math meta 丢弃，末尾结束符也不能混入矩阵并吞掉后文。
  test.each([
    ["静态消息", "static", false],
    ["流式结束", "streaming", false],
    ["流式生成中", "streaming", true],
  ] as const)("%s 中矩阵与开闭定界符同行仍能渲染", async (_name, mode, isStreaming) => {
    const matrix = String.raw`\begin{pmatrix}
0.2225 & -0.1628 & -0.0599\\
-0.1628 & 0.1851 & -0.0220\\
-0.0599 & -0.0220 & 0.0819
\end{pmatrix}`;
    const host = await renderMessage(`用 P14 代入：\n\n$$${matrix}$$\n\n两个性质：\n\n- 对角线为正`, mode, isStreaming);

    await waitFor(host, ".katex, .katex-error");

    expect(host.querySelectorAll(".katex-error").length).toBe(0);
    expect(host.querySelectorAll(".katex-display").length).toBe(1);
    expect([...host.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual([matrix]);
    expect(host.querySelector(".mtable")).not.toBeNull();
    expect([...host.querySelectorAll("p")].some((node) => node.textContent === "两个性质：")).toBe(true);
    expect(host.querySelector("li")?.textContent).toBe("对角线为正");
  });

  // 列表与引用中的代码仍是源码，不能被块公式容错改写显示、复制或下载内容。
  test.each([
    ["列表波浪线围栏", "- ~~~md\n  $$\n  x$$\n  ~~~", "$$\nx$$\n"],
    ["列表反引号围栏", "- ```md\n  $$\n  x$$\n  ```\n\n后文", "$$\nx$$\n"],
    ["嵌套列表围栏", "- 项目\n  - ~~~md\n    $$\n    x$$\n    ~~~", "$$\nx$$\n"],
    ["引用代码围栏", "> ~~~md\n> $$\n> x$$\n> ~~~", "$$\nx$$\n"],
    ["缩进代码", "    $$\n    x$$", "$$\nx$$\n"],
    ["math-display 语言围栏", "```math-display\nx^2\n```", "x^2\n"],
  ])("%s 保留公式示例原文", async (_name, markdown, code) => {
    const host = await renderMessage(markdown);
    await waitFor(host, "code, .katex");

    expect(host.querySelectorAll(".katex").length).toBe(0);
    expect([...host.querySelector("code")!.children].map((node) => node.textContent).join("\n")).toBe(code.trimEnd());
  });

  // 模型把块公式的结束符贴在公式后时，仍须显示公式，并保留紧随其后的正文和下一条公式。
  test.each([
    ["静态消息", "static", false],
    ["流式结束", "streaming", false],
    ["流式生成中", "streaming", true],
  ] as const)("%s 中混合换行的公式正常渲染", async (_name, mode, isStreaming) => {
    const formula = String.raw`\frac{\partial}{\partial B}\mathrm{tr}(\Lambda B^TB)=B(\Lambda+\Lambda^T)=2B\Lambda.`;
    const host = await renderMessage(
      `**第 2 步：一阶条件。**\n\n$$\n${formula}$$\n令 $\\partial L/\\partial B=0$，得\n\n$$\n\\Sigma B=B\\Lambda\n$$`,
      mode,
      isStreaming,
    );

    await waitFor(host, ".katex");

    expect(host.querySelector(".katex-error")?.getAttribute("title") ?? null).toBeNull();
    expect([...host.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual([
      formula,
      String.raw`\partial L/\partial B=0`,
      String.raw`\Sigma B=B\Lambda`,
    ]);
    expect([...host.querySelectorAll("p")].some((node) => node.textContent?.startsWith("令 "))).toBe(true);
  });

  // 多条坏公式可能互相吞掉开头；修正后每条公式都须独立识别，不能吞正文或代码。
  test.each([
    ["连续公式", "$$\nx$$\n\n$$\ny$$\n\n$$\nz$$", ["x", "y", "z"]],
    ["CRLF", "$$\r\nx^2$$", ["x^2"]],
    ["缩进公式", "  $$\n  x$$", ["x"]],
    ["未配对反引号后的公式", "示例 `\n\n$$\nx$$", ["x"]],
    ["代码后的公式", "~~~md\n$$\nx$$\n~~~\n\n$$\ny$$", ["y"]],
    ["公式后的代码", "$$\nx$$\n\n~~~md\n$$\ny$$\n~~~", ["x"]],
    ["开头贴行", "$$x+y\n$$\n\n后文", ["x+y"]],
    ["连续开头贴行", "$$x\ny\n$$\n$$a\nb\n$$", ["x\ny", "a\nb"]],
    [
      "矩阵开头贴行且使用 CRLF",
      "$$\\begin{pmatrix}\r\n1 & 2\r\n\\end{pmatrix}\r\n$$",
      ["\\begin{pmatrix}\n1 & 2\n\\end{pmatrix}"],
    ],
    ["缩进矩阵", "  $$\\begin{pmatrix}\n  1 & 2\n  \\end{pmatrix}$$", ["\\begin{pmatrix}\n1 & 2\n\\end{pmatrix}"]],
  ])("%s 保留独立公式的边界", async (_name, markdown, formulas) => {
    const host = await renderMessage(markdown);
    await waitFor(host, ".katex");

    expect(host.querySelectorAll(".katex-error").length).toBe(0);
    expect([...host.querySelectorAll("annotation")].map((node) => node.textContent)).toEqual(formulas);
    if (markdown.includes("~~~")) {
      expect([...host.querySelector("code")!.children].map((node) => node.textContent)).toEqual([
        "$$",
        markdown.includes("~~~md\n$$\nx") ? "x$$" : "y$$",
      ]);
    }
  });

  // 开头修正后须重新识别代码边界，不能继续修改原先被公式吞掉的代码示例。
  test("矩阵后的代码示例保留原文", async () => {
    const host = await renderMessage(
      "$$\\begin{pmatrix}\n1 & 2\n\\end{pmatrix}$$\n\n~~~md\n$$\\begin{pmatrix}\n3 & 4\n\\end{pmatrix}$$\n~~~",
    );

    await waitFor(host, ".katex, .katex-error");

    expect(host.querySelectorAll(".katex-error").length).toBe(0);
    expect(host.querySelectorAll(".katex").length).toBe(1);
    expect([...host.querySelector("code")!.children].map((node) => node.textContent)).toEqual([
      "$$\\begin{pmatrix}",
      "3 & 4",
      "\\end{pmatrix}$$",
    ]);
  });

  // display 标记只属于双美元；普通行内公式及列表、引用中的双美元均保留各自模式。
  test("混合上下文按美元定界符选择显示模式", async () => {
    const host = await renderMessage("行内 $x^2$，行间 $$y^2$$。\n\n- $$a\\tag{A}$$\n\n> $$b\\tag{B}$$");

    await waitFor(host, ".katex, .katex-error");

    expect(host.querySelectorAll(".katex-error").length).toBe(0);
    expect(host.querySelectorAll(".katex").length).toBe(4);
    expect(host.querySelectorAll(".katex-display").length).toBe(3);
    expect(host.querySelectorAll(".tag").length).toBe(2);
  });

  // 行内 `$…$` 与行间 `$$…$$` 都要真的渲染成公式节点：这是接入 math 插件的全部意义
  test("行内与行间公式渲染为 KaTeX 节点", async () => {
    const host = await renderMessage("Inline $a^2 + b^2$ end.\n\n$$\n\\int_0^1 x\\,dx\n$$\n");

    await waitFor(host, ".katex");

    expect(host.querySelectorAll(".katex").length).toBe(2);
    expect(host.querySelector(".katex-display")).not.toBeNull();
    // 定界符不该残留在正文里
    expect(host.textContent ?? "").not.toContain("$$");
  });

  // AMS 环境在 chat 里由 remark-math 解析，必须写在 `$$…$$` 内（裸写的边界见包 README 已知限制第 15 条）
  test("$$ 包裹的 AMS 环境按行间公式渲染", async () => {
    const host = await renderMessage("$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$\n");

    await waitFor(host, ".katex-display");

    expect(host.querySelector(".katex-display")).not.toBeNull();
  });

  // 代码围栏里的 `$` 是示例代码，不是公式（否则公式会把代码啃掉）
  test("代码围栏内的美元符号不参与公式渲染", async () => {
    const host = await renderMessage("```js\nconst price = $5;\n```\n");

    await waitFor(host, "pre");
    await flush();

    expect(host.querySelectorAll(".katex").length).toBe(0);
    expect(host.textContent ?? "").toContain("const price = $5;");
  });
});

describe("聊天正文的数学降级", () => {
  // KaTeX 认不出的宏：就地按错误色渲染，前后正文必须一字不少（一条坏公式不能吞掉整条消息）
  test("不支持的宏就地按错误色渲染且不吞正文", async () => {
    const host = await renderMessage("前文 $\\notarealmacro{x}$ 后文");

    await waitFor(host, ".katex");

    expect(host.querySelector(".katex")?.innerHTML).toContain("#cc0000");
    expect(host.textContent ?? "").toContain("前文");
    expect(host.textContent ?? "").toContain("后文");
  });

  // 连错误态渲染都拿不下的环境（rehype-katex 自造错误节点）：正文同样要留下
  test("不支持的环境留下错误节点而不是让消息失败", async () => {
    const host = await renderMessage("前文 $$\\begin{eqnarray}a &=& b\\end{eqnarray}$$ 后文");

    await waitFor(host, ".katex-error");

    expect(host.querySelector(".katex-error")?.textContent ?? "").toContain("eqnarray");
    expect(host.textContent ?? "").toContain("后文");
  });
});
