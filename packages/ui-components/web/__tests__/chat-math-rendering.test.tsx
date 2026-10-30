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
async function renderMessage(markdown: string): Promise<HTMLElement> {
  const { MessageResponse } = await import("../chat/primitives/message");
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <MessageResponse mode="static">{markdown}</MessageResponse>
      </I18nextProvider>,
    );
  });
  return host;
}

describe("聊天正文的数学渲染", () => {
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
