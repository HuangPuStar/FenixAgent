// QuestionPanel（AskUserQuestion 输入框上方交互面板）测试（CE 阶段 2 §1.6 T6c1 从
// `packages/agent-runtime/web/__tests__/question-panel.test.tsx` 迁入包内）：
// - 空列表 → 不渲染
// - 多问题/多选项渲染：header + question + 选项按钮
// - 交互：单选题只保留一个选项，多选题可切换多个选项；点击"提交"后按
//   问题顺序回传答案（单选 string，多选 string[]）
//
// 迁移改动：
// - 组件改从包内 `../chat/panels/QuestionPanel` 导入，问题投影类型改从 `../chat/types` 导入
//   （不再依赖 `@fenix/chat-channel`）；
// - happy-dom 引导改用包内 `@fenix/ui-components/testing` 入口（原先是 apps/web 的
//   `happy-dom-window` 副本）；包内 QuestionPanel 是输入框上方的内联卡片、无 Radix Portal，
//   故不再需要原文件里为 Dialog 挂载链补的 Event/MutationObserver/getComputedStyle 全局补齐；
// - i18n 换成包内 `createInstance` + `../i18n/locales/en/uiComponents.json`：源测试在 i18next
//   未初始化时断言 `t()` 回显 key（`askUser.submit` / `askUser.next` / `askUser.nextQuestion`），
//   包内已注册字典，改为比字典译文（key 前缀变为 `chat.components.askUser.*`）；
// - 纯化后组件不再直连宿主 transport，问题数据与应答全部由 props 注入；原测试本就以 props 打桩，
//   无需宿主侧桩改写。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { QuestionPanel } from "../chat/panels/QuestionPanel";
import type { QuestionProjection } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

// 最小 DOM 环境（react-dom/client 与 radix 模块加载需要 document）。
// 注意：bun test 运行时已预置一个普通 window 对象（无 getComputedStyle 等 DOM 能力），
// 必须无条件接管为当前 happy-dom 实例——测试文件之间串行执行（先顶层加载后跑测试），
// 后加载文件的覆盖不影响已完成文件的断言，而渲染必须与注入落在同一个 Window 上。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const g = globalThis as Record<string, unknown>;
const win = initializeHappyDomWindow(new Window());
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
const documentRef = win.document;

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

/** 读包内英文字典的 chat 子树；字典尚未搬运或键缺失时回落 key（`chat.` + path）。 */
function chatText(path: string): string {
  let current: unknown = (en as Record<string, unknown>).chat;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return `chat.${path}`;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : `chat.${path}`;
}

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

/** 挂载出一个独立的 React root（happy-dom 元素类型与 lib.dom 声明不重叠，经 unknown 收窄）。 */
function mountRoot(): { container: HTMLElement; root: Root } {
  const container = documentRef.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);
  return { container: container as unknown as HTMLElement, root };
}

describe("QuestionPanel", () => {
  // 空列表 → 不渲染（pendingQuestions 投影为空时无弹窗）
  test("空列表时返回 null（无弹窗）", () => {
    const { container, root } = mountRoot();
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
    const { container, root } = mountRoot();
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
    const { container, root } = mountRoot();
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
    const { container, root } = mountRoot();
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
    // 提交按钮文案取包内字典译文（源测试断言 i18next 未初始化时回显的 key）
    const submitButton = buttons.find((b) => b.textContent?.includes(chatText("components.askUser.submit")));
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
    const { container, root } = mountRoot();
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

    const nextLabel = chatText("components.askUser.next");
    expect(
      Array.from(container.querySelectorAll("button")).filter((button) => button.textContent === nextLabel),
    ).toHaveLength(0);
    const programmingButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("programming"),
    );
    act(() => programmingButton!.click());

    const nextButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === nextLabel,
    );
    expect(nextButton).toBeDefined();
    act(() => nextButton!.click());
    expect(container.textContent).toContain("Difficulty?");
    expect(responses).toEqual([]);
    act(() => root.unmount());
  });

  // 最后一题选中后不显示“下一个”，只保留“提交”作为完成整个问卷的动作。
  test("最后一题不显示下一个按钮以避免与提交语义冲突", () => {
    const { container, root } = mountRoot();
    const question = pendingQuestion("iqa_1", [{ question: "Deploy?", options: ["yes", "no"] }]);
    act(() => {
      root.render(createElement(QuestionPanel, { questions: [question], onRespond: () => {} }));
    });

    const yesButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("yes"),
    );
    act(() => yesButton!.click());
    expect(
      Array.from(container.querySelectorAll("button")).filter(
        (button) => button.textContent === chatText("components.askUser.next"),
      ),
    ).toHaveLength(0);
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === chatText("components.askUser.submit"),
      ),
    ).toBe(true);
    act(() => root.unmount());
  });

  // 多问题独立选中：每个问题项各自选中互不干扰，全部选中后提交合并回传（按问题顺序）
  test("多问题独立选中，全部选中后提交合并回传", () => {
    const { container, root } = mountRoot();
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
    const submitButton = buttons.find((b) => b.textContent?.includes(chatText("components.askUser.submit")));
    const programmingButton = buttons.find((b) => b.textContent?.includes("programming"));
    const nextButton = buttons.find(
      (b) => b.getAttribute("aria-label") === chatText("components.askUser.nextQuestion"),
    );
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
    const { container, root } = mountRoot();
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
    const submitButton = buttons.find((button) => button.textContent?.includes(chatText("components.askUser.submit")));
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
    const { container, root } = mountRoot();
    const question = pendingQuestion("iqa_1", [{ question: "Deploy to prod?", options: ["production", "staging"] }]);
    act(() => {
      root.render(createElement(QuestionPanel, { questions: [question], onRespond: () => {} }));
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const submitButton = buttons.find((b) => b.textContent?.includes(chatText("components.askUser.submit")));
    expect(submitButton).toBeDefined();
    // happy-dom 按钮元素类型与 lib.dom 不重叠，经 unknown 收窄后读取 disabled
    expect((submitButton as unknown as HTMLButtonElement).disabled).toBe(true);
    act(() => root.unmount());
  });
});
