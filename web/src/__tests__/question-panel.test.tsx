// web/src/__tests__/question-panel.test.tsx
// QuestionPanel（AskUserQuestion 输入框上方交互面板）测试：
// - 空列表 → 不渲染
// - 多问题/多选项渲染：header + question + 选项按钮
// - 交互：单选题只保留一个选项，多选题可切换多个选项；点击"提交"后按
//   问题顺序回传答案（单选 string，多选 string[]）

import { describe, expect, test } from "bun:test";
import type { QuestionProjection } from "@fenix/chat-channel";
// Element/CSSStyleDeclaration 引用 happy-dom 自身类型（与 win.getComputedStyle
// 签名一致，避免 lib.dom 与 happy-dom 声明的函数类型不兼容）
import { CSSStyleDeclaration, Element, Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initializeHappyDomWindow } from "./happy-dom-window";

// 最小 DOM 环境（react-dom/client 与 radix 模块加载需要 document）。
// 注意：bun test 运行时已预置一个普通 window 对象（无 getComputedStyle 等 DOM
// 能力），且其他 happy-dom 测试（use-chat-state-hook 等）可能先设置了全局
// window/document。必须无条件接管为当前 happy-dom 实例——测试文件之间串行
// 执行（先顶层加载后跑测试），后加载文件的覆盖不影响已完成文件的断言，
// 而渲染必须与注入落在同一个 Window 上，否则 Radix Portal/dispatchEvent
// 类型校验全部失败。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as Record<string, unknown>;
const win = initializeHappyDomWindow(new Window());
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
const documentRef = win.document;

// ── happy-dom 20.10.1 + bun 环境的全局补齐（Radix Dialog 挂载链所需）──
// 1. radix 用全局 Event/CustomEvent 构造事件，happy-dom dispatchEvent 用
//    instanceof 校验，类型必须一致 → 全局事件类替换为 happy-dom 实现；
// 2. radix 依赖链（focus-scope/focus-guards/dismissable-layer）以全局形式引用
//    MutationObserver / NodeFilter / HTMLInputElement / requestAnimationFrame /
//    matchMedia 等，happy-dom 只挂在 Window 实例上 → 把 bun 全局缺失的
//    Window 构造器统一注入（!(key in g) 保护，不覆盖 setTimeout 等 bun 运行时对象）。
for (const key of [
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "UIEvent",
  "PointerEvent",
  "WheelEvent",
  "InputEvent",
  "CompositionEvent",
  "TouchEvent",
  "DragEvent",
]) {
  // 无条件覆盖：bun 预置的全局 Event 是残缺实现（与 happy-dom document 类型不匹配，
  // dispatchEvent instanceof 校验失败），必须替换为 happy-dom 版本
  const hd = (win as unknown as Record<string, unknown>)[key];
  if (hd) g[key] = hd;
}
for (const obj of [win, Object.getPrototypeOf(win)]) {
  const record = obj as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(record)) {
    // NodeFilter 等是静态常量类（object 类型），同样需要注入；window/document 等
    // 已显式设置（key in g 跳过），setTimeout 等 bun 运行时对象也不被覆盖
    if (typeof record[key] !== "undefined" && !(key in g)) g[key] = record[key];
  }
}

// getComputedStyle 空值 stub：react-remove-scroll-bar 在 Dialog 挂载时读取
// body 的 paddingLeft 等计算样式（happy-dom computed-style 实现路径复杂且
// 依赖 styleSheets 解析，空文档下无意义）；空值语义 = 默认样式（offset/gap 全 0），
// 与 radix focus-scope 可见性判断（空 ≠ hidden/none）兼容。
// focus-scope 以全局函数形式调用 getComputedStyle，故同时覆盖全局与 Window。
function stubComputedStyle(_el: Element): CSSStyleDeclaration {
  return new Proxy({} as CSSStyleDeclaration, {
    get: (_target, prop) => (prop === "getPropertyValue" ? () => "" : ""),
  });
}
g.getComputedStyle = stubComputedStyle;
win.getComputedStyle = stubComputedStyle;

// 动态导入：radix 依赖链（@radix-ui/react-dialog → react-portal →
// react-use-layout-effect）在此之后加载，document 已就绪
const { QuestionPanel } = await import("../../components/chat/QuestionPanel");

/** 构造一份待应答问题投影（expiresAt 未过，直接交给组件消费）；支持多问题项 */
function pendingQuestion(
  questionId: string,
  items: Array<{ question: string; options: string[]; multiSelect?: boolean }>,
): QuestionProjection {
  return {
    questionId,
    status: "pending",
    questions: items.map((item) => ({
      question: item.question,
      header: "Deploy",
      options: item.options.map((label) => ({ label, description: null })),
      multiSelect: item.multiSelect ?? false,
    })),
    description: "Please answer the following questions",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    answer: null,
  };
}

describe("QuestionPanel", () => {
  // 空列表 → 不渲染（pendingQuestions 投影为空时无弹窗）
  test("空列表时返回 null（无弹窗）", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    act(() => {
      root.render(createElement(QuestionPanel, { questions: [], onRespond: () => {} }));
    });
    expect(container.innerHTML).toBe("");
    expect(documentRef.body.textContent ?? "").toBe("");
    act(() => root.unmount());
  });

  // 多选项渲染：header + 问题文本 + 每个选项一个按钮 + 提交按钮
  // 面板为输入框上方内联布局（无 Radix Portal），内容渲染在挂载容器内
  test("渲染 header、问题文本与全部选项按钮", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const question = pendingQuestion("iqa_1", [
      { question: "Which deployment target?", options: ["production", "staging"] },
    ]);
    act(() => {
      root.render(createElement(QuestionPanel, { questions: [question], onRespond: () => {} }));
    });
    const bodyText = container.textContent ?? "";
    expect(bodyText).toContain("Deploy");
    expect(bodyText).toContain("Which deployment target?");
    expect(bodyText).toContain("production");
    expect(bodyText).toContain("staging");
    act(() => root.unmount());
  });

  // 多问题渲染：同一面板内展示多个待应答问题
  test("渲染多个待应答问题", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const questions = [
      pendingQuestion("iqa_1", [{ question: "Deploy to prod?", options: ["yes", "no"] }]),
      pendingQuestion("iqa_2", [{ question: "Run tests?", options: ["all", "none"] }]),
    ];
    act(() => {
      root.render(createElement(QuestionPanel, { questions, onRespond: () => {} }));
    });
    const bodyText = container.textContent ?? "";
    expect(bodyText).toContain("Deploy to prod?");
    expect(bodyText).toContain("Run tests?");
    expect(bodyText).toContain("yes");
    expect(bodyText).toContain("none");
    act(() => root.unmount());
  });

  // 两步交互：点击选项仅标记选中，不立即回传；点提交按钮才回传选中项数组
  test("点击选项不立即回传，点提交按钮才回传选中选项", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const responses: Array<{ questionId: string; answers: Array<string | string[]> }> = [];
    const question = pendingQuestion("iqa_1", [{ question: "Deploy to prod?", options: ["production", "staging"] }]);
    act(() => {
      root.render(
        createElement(QuestionPanel, {
          questions: [question],
          onRespond: (questionId, answers) => responses.push({ questionId, answers }),
        }),
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const productionButton = buttons.find((b) => b.textContent?.includes("production"));
    // bun 测试环境 i18next 未初始化资源 → t() 回退返回 key（"askUser.submit"）
    const submitButton = buttons.find((b) => b.textContent?.includes("askUser.submit"));
    expect(productionButton).toBeDefined();
    expect(submitButton).toBeDefined();

    // 点击选项：仅选中，未提交
    act(() => {
      productionButton!.click();
    });
    expect(responses).toEqual([]);

    // 点提交：回传选中项数组（单问题 = 长度 1）
    act(() => {
      submitButton!.click();
    });
    expect(responses).toEqual([{ questionId: "iqa_1", answers: ["production"] }]);
    act(() => root.unmount());
  });

  // 选中当前题后显示文字“下一个”按钮；点击仅前进到下一题，不触发提交。
  test("选中非末题后可通过下一个按钮前进且不提交", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const responses: Array<{ questionId: string; answers: Array<string | string[]> }> = [];
    const question = pendingQuestion("iqa_1", [
      { question: "Topic?", options: ["programming", "math"] },
      { question: "Difficulty?", options: ["easy", "hard"] },
    ]);
    act(() => {
      root.render(
        createElement(QuestionPanel, {
          questions: [question],
          onRespond: (questionId, answers) => responses.push({ questionId, answers }),
        }),
      );
    });

    expect(
      Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "askUser.next"),
    ).toHaveLength(0);
    const programmingButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("programming"),
    );
    act(() => programmingButton!.click());

    const nextButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "askUser.next",
    );
    expect(nextButton).toBeDefined();
    act(() => nextButton!.click());
    expect(container.textContent).toContain("Difficulty?");
    expect(responses).toEqual([]);
    act(() => root.unmount());
  });

  // 最后一题选中后不显示“下一个”，只保留“提交”作为完成整个问卷的动作。
  test("最后一题不显示下一个按钮以避免与提交语义冲突", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const question = pendingQuestion("iqa_1", [{ question: "Deploy?", options: ["yes", "no"] }]);
    act(() => {
      root.render(createElement(QuestionPanel, { questions: [question], onRespond: () => {} }));
    });

    const yesButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("yes"),
    );
    act(() => yesButton!.click());
    expect(
      Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === "askUser.next"),
    ).toHaveLength(0);
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "askUser.submit"),
    ).toBe(true);
    act(() => root.unmount());
  });

  // 多问题独立选中：每个问题项各自选中互不干扰，全部选中后提交合并回传（按问题顺序）
  test("多问题独立选中，全部选中后提交合并回传", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const responses: Array<{ questionId: string; answers: Array<string | string[]> }> = [];
    const question = pendingQuestion("iqa_1", [
      { question: "Topic?", options: ["programming", "math"] },
      { question: "Difficulty?", options: ["easy", "hard"] },
    ]);
    act(() => {
      root.render(
        createElement(QuestionPanel, {
          questions: [question],
          onRespond: (questionId, answers) => responses.push({ questionId, answers }),
        }),
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const submitButton = buttons.find((b) => b.textContent?.includes("askUser.submit"));
    const programmingButton = buttons.find((b) => b.textContent?.includes("programming"));
    const nextButton = buttons.find((b) => b.getAttribute("aria-label") === "askUser.nextQuestion");
    expect(submitButton).toBeDefined();
    expect(programmingButton).toBeDefined();
    expect(nextButton).toBeDefined();

    // 只选第一个问题：提交仍禁用（第二个问题未答）
    act(() => {
      programmingButton!.click();
    });
    expect((submitButton as unknown as HTMLButtonElement).disabled).toBe(true);

    // 切到第二个问题后选中，第一题答案仍保留，提交按 schema 顺序回传。
    act(() => {
      nextButton!.click();
    });
    const easyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("easy"),
    );
    expect(easyButton).toBeDefined();
    act(() => {
      easyButton!.click();
    });
    expect((submitButton as unknown as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      submitButton!.click();
    });
    expect(responses).toEqual([{ questionId: "iqa_1", answers: ["programming", "easy"] }]);
    act(() => root.unmount());
  });

  // 多选问题允许同时选中多个选项，提交时保留该题的完整选择数组。
  test("多选问题可同时选中多个选项并完整回传", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const responses: Array<{ questionId: string; answers: Array<string | string[]> }> = [];
    const question = pendingQuestion("iqa_multi", [
      { question: "Choose targets", options: ["web", "server", "worker"], multiSelect: true },
    ]);
    act(() => {
      root.render(
        createElement(QuestionPanel, {
          questions: [question],
          onRespond: (questionId, answers) => responses.push({ questionId, answers }),
        }),
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const webButton = buttons.find((button) => button.textContent?.includes("web"));
    const serverButton = buttons.find((button) => button.textContent?.includes("server"));
    const submitButton = buttons.find((button) => button.textContent?.includes("askUser.submit"));
    expect(webButton).toBeDefined();
    expect(serverButton).toBeDefined();
    expect(submitButton).toBeDefined();

    act(() => {
      webButton!.click();
      serverButton!.click();
    });
    expect(webButton!.getAttribute("aria-pressed")).toBe("true");
    expect(serverButton!.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      submitButton!.click();
    });
    expect(responses).toEqual([{ questionId: "iqa_multi", answers: [["web", "server"]] }]);
    act(() => root.unmount());
  });

  // 未选中任何选项时提交按钮禁用（不可提交空答案）
  test("未选中选项时提交按钮禁用", () => {
    const container = documentRef.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    const question = pendingQuestion("iqa_1", [{ question: "Deploy to prod?", options: ["production", "staging"] }]);
    act(() => {
      root.render(createElement(QuestionPanel, { questions: [question], onRespond: () => {} }));
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const submitButton = buttons.find((b) => b.textContent?.includes("askUser.submit"));
    expect(submitButton).toBeDefined();
    // happy-dom 按钮元素类型与 lib.dom 不重叠，经 unknown 收窄后读取 disabled
    expect((submitButton as unknown as HTMLButtonElement).disabled).toBe(true);
    act(() => root.unmount());
  });
});
