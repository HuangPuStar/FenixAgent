// web/src/__tests__/question-panel-custom-answer.test.tsx
// AskUserQuestion 面板「自定义回答」输入框的接线契约：用户在弹窗里输入的自由文本（例如
// `/multitask`）必须与选项答案走**同一条**通路 —— 同一个 `onRespond(questionId, answers)`
// 回调，宿主侧即 `sendAction({ action: "respond_question", questionId, answers })`；
// 载荷形态也一致（单选 string / 多选 string[]，顺序按问题项），**不新增消息类型、不伪造字段**。
//
// 为什么只在这一层钉：自由文本在协议侧不需要任何新表达 —— 后端 `normalizeQuestionAnswers`
// 保留任意非空字符串、translator 原样放进 `control_response.extra.answers`、acp-link
// `buildElicitationContent` 以 `content[q_id] = <文本>` 组装 elicitation 结果。因此本文件的
// 判据是「自定义文本产生的载荷 == 选项产生的载荷（除元素值本身外无差异）」，而不是新增的字段或帧。
//
// 覆盖：提交载荷同形；空/纯空白不可提交；文本与选项互斥；Enter 提交；多选数组形态；
// 提交中防重复提交（loading 反馈）；提交未确认的超时兜底与重试出口；多问题按序合并载荷。

import { describe, expect, jest, test } from "bun:test";
import { QuestionPanel } from "@fenix/ui-components/chat/panels/QuestionPanel";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";

const window = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = window;
globalRecord.document = window.document;
globalRecord.navigator = window.navigator;
// `HTMLElement` 与 `customElements` 成对注入（前端规范 §11.2）：只注入前者会让后续文件里
// streamdown 的 web-components 判定「有 DOM、没有注册表」而崩在用例之间的空档里。
globalRecord.HTMLElement = window.HTMLElement;
globalRecord.customElements = window.customElements;
globalRecord.IS_REACT_ACT_ENVIRONMENT = true;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: uiComponentsResources.en } },
});

const COPY = uiComponentsResources.en.chat.components.askUser;

/** 一次提交捕获（questionId + answers 原样留存，用于比对自定义文本与选项的载荷差异）。 */
type Response = { questionId: string; answers: Array<string | string[]> };

/** 构造待应答问题投影（expiresAt 未过；组件只消费投影，不做过滤）。 */
function pendingQuestion(
  questionId: string,
  items: Array<{ question: string; options: string[]; multiSelect?: boolean }>,
) {
  return {
    questionId,
    status: "pending" as const,
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

/** 挂载面板并捕获提交载荷；happy-dom 元素类型与 lib.dom 声明不重叠，经 unknown 收窄。 */
function mountPanel(question: ReturnType<typeof pendingQuestion>): {
  container: HTMLElement;
  root: Root;
  responses: Response[];
} {
  const responses: Response[] = [];
  const container = window.document.createElement("div");
  window.document.body.appendChild(container as unknown as Parameters<typeof window.document.body.appendChild>[0]);
  const root: Root = createRoot(container as unknown as HTMLElement);
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <QuestionPanel
          questions={[question]}
          onRespond={(questionId, answers) => responses.push({ questionId, answers })}
        />
      </I18nextProvider>,
    );
  });
  return { container: container as unknown as HTMLElement, root, responses };
}

/** 按文案定位按钮（图标按钮只有 aria-label，不参与匹配）。 */
function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`未找到按钮：${text}`);
  return button;
}

/** 按无障碍名（aria-label）定位纯图标按钮：分页的上一题/下一题。 */
function findButtonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`未找到无障碍名为「${label}」的按钮`);
  return button;
}

/** 取自定义回答输入框（每张卡片当前问题一个）。 */
function customInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector("input");
  if (!input) throw new Error("自定义回答输入框未渲染");
  return input;
}

/**
 * 模拟键盘输入自定义回答。happy-dom 下 React 走「input 事件 polyfill」分支
 * （`isEventSupported("input")` 判定为 false），`onChange` 只在**聚焦元素**的
 * keydown/keyup 上比对值变化，直接派发 `input` 事件不会触发；而受控输入框的值又由 React
 * 值跟踪器比对，直接赋 `input.value` 会被判成「未变化」。因此这里按「聚焦 → 原型原生 setter
 * 改值 → keydown」三步逼近真实键盘输入，效果等价于浏览器里的「值变化 → onChange」。
 * keydown 的 key 取所输入文本的末字符，避免误用 Enter 触发提交。
 */
function typeCustomAnswer(container: HTMLElement, value: string): void {
  const input = customInput(container);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
  if (!setter) throw new Error("happy-dom 未在原型上提供 value setter");
  act(() => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: value.slice(-1) || "a", bubbles: true }) as unknown as Event,
    );
  });
}

/** 在自定义回答输入框上敲 Enter（键盘提交出口）。 */
function pressEnter(container: HTMLElement, init: { shiftKey?: boolean } = {}): void {
  const input = customInput(container);
  act(() => {
    input.focus();
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: init.shiftKey ?? false,
        bubbles: true,
      }) as unknown as Event,
    );
  });
}

describe("AskUserQuestion 自定义回答", () => {
  // 业务意图：用户输入的自由文本要能在弹窗内直接提交，且走的必须是选项那条通路——
  // 同一个 onRespond 回调、同一个 answers 数组（单问题 = 长度 1 的字符串数组），
  // 这样宿主 sendAction({ action: "respond_question" }) 无需任何分支即可把它送到 agent。
  test("输入自定义文本提交：载荷与选项答案同形（同一 answers 数组、无新增字段）", () => {
    const { container, root, responses } = mountPanel(
      pendingQuestion("iqa_1", [{ question: "接下来做什么？", options: ["production", "staging"] }]),
    );

    // 基线：点选项提交产生的载荷形态
    act(() => findButton(container, "production").click());
    act(() => findButton(container, COPY.submit).click());
    expect(responses).toEqual([{ questionId: "iqa_1", answers: ["production"] }]);

    // 自定义文本：同一个回调、同一个数组结构，只有元素值不同
    act(() => root.unmount());
    const custom = mountPanel(pendingQuestion("iqa_1", [{ question: "接下来做什么？", options: ["production"] }]));
    typeCustomAnswer(custom.container, "/multitask");
    act(() => findButton(custom.container, COPY.submit).click());

    expect(custom.responses).toEqual([{ questionId: "iqa_1", answers: ["/multitask"] }]);
    expect(typeof custom.responses[0]?.answers[0]).toBe("string");
    act(() => custom.root.unmount());
  });

  // 业务意图：空输入不可提交——提交按钮的可用性必须覆盖两个答案来源，否则用户什么都没答
  // 也能点提交，服务端只能按空答案处理（agent 收到空回答）。
  test("空输入与纯空白输入都不算作答，提交按钮保持禁用", () => {
    const { container, root, responses } = mountPanel(
      pendingQuestion("iqa_1", [{ question: "接下来做什么？", options: ["production"] }]),
    );
    const submit = findButton(container, COPY.submit);
    expect(submit.disabled).toBe(true);

    typeCustomAnswer(container, "   ");
    expect(findButton(container, COPY.submit).disabled).toBe(true);

    // 纯空白文本即便被强点也不得发出载荷
    act(() => findButton(container, COPY.submit).click());
    expect(responses).toEqual([]);
    act(() => root.unmount());
  });

  // 业务意图：一个 q_id 只能有一个答案来源。输入自定义文本即视为放弃选项（选项选中被清空），
  // 这样交给 agent 的答案不会出现「既选了 production 又给了一段文本」的歧义载荷。
  test("自定义文本与选项互斥：输入文本清空该项选项，点击选项清空文本", () => {
    const options = [{ question: "接下来做什么？", options: ["production", "staging"] }];

    // 先选选项再输入文本：选项选中被清空，载荷只含文本
    const first = mountPanel(pendingQuestion("iqa_1", options));
    act(() => findButton(first.container, "production").click());
    expect(findButton(first.container, "production").getAttribute("aria-pressed")).toBe("true");

    typeCustomAnswer(first.container, "/multitask");
    expect(findButton(first.container, "production").getAttribute("aria-pressed")).toBe("false");
    act(() => findButton(first.container, COPY.submit).click());
    expect(first.responses).toEqual([{ questionId: "iqa_1", answers: ["/multitask"] }]);
    act(() => first.root.unmount());

    // 先输入文本再点选项：输入框被清空，载荷回到选项 label
    const second = mountPanel(pendingQuestion("iqa_1", options));
    typeCustomAnswer(second.container, "/multitask");
    act(() => findButton(second.container, "staging").click());
    expect(customInput(second.container).value).toBe("");
    // 单选题重复点击同一项仍是该项（不因二次点击被清空）
    act(() => findButton(second.container, "staging").click());
    act(() => findButton(second.container, COPY.submit).click());
    expect(second.responses).toEqual([{ questionId: "iqa_1", answers: ["staging"] }]);
    act(() => second.root.unmount());
  });

  // 业务意图：键盘可提交（Enter）必须与点提交按钮产出同一份载荷；未全部作答时 Enter 不得
  // 抢先提交半份答案，Shift+Enter 留给换行等默认行为。
  test("Enter 提交同一份载荷；未全部作答时 Enter 不提交", () => {
    const { container, root, responses } = mountPanel(
      pendingQuestion("iqa_1", [
        { question: "下一步动作？", options: ["production"] },
        { question: "范围？", options: ["all"] },
      ]),
    );

    // 第 1 题答完、第 2 题未答：Enter 不得提交
    typeCustomAnswer(container, "/multitask");
    pressEnter(container);
    expect(responses).toEqual([]);

    // Shift+Enter 不是提交出口（保留给换行等默认行为）
    pressEnter(container, { shiftKey: true });
    expect(responses).toEqual([]);

    // 第 2 题也作答后 Enter 提交：载荷按问题顺序合并
    act(() => findButton(container, COPY.next).click());
    typeCustomAnswer(container, "只改前端");
    pressEnter(container);
    expect(responses).toEqual([{ questionId: "iqa_1", answers: ["/multitask", "只改前端"] }]);
    act(() => root.unmount());
  });

  // 业务意图：多选题的答案在协议侧是数组，自定义文本作为该题唯一答案时必须仍是数组
  // （不能被拼进已选选项，也不能降级成字符串导致 q_id 类型错配）。
  test("多选题输入自定义文本：以单元素数组提交，且不含任何选项 label", () => {
    const { container, root, responses } = mountPanel(
      pendingQuestion("iqa_1", [{ question: "选哪些？", options: ["a", "b"], multiSelect: true }]),
    );

    act(() => findButton(container, "a").click());
    typeCustomAnswer(container, "/multitask");
    expect(findButton(container, "a").getAttribute("aria-pressed")).toBe("false");

    act(() => findButton(container, COPY.submit).click());
    expect(responses).toEqual([{ questionId: "iqa_1", answers: [["/multitask"]] }]);
    act(() => root.unmount());
  });

  // 业务意图：提交是「一次」动作——提交中必须给出反馈（按钮转圈 + 禁用）并挡住重复提交，
  // 否则用户连点会向服务端发多条同载荷 action（虽被 CAS 去重，但会造成无谓的重复帧）。
  test("提交中：按钮禁用并显示提交中反馈，重复点击不产生第二份载荷", () => {
    const { container, root, responses } = mountPanel(
      pendingQuestion("iqa_1", [{ question: "接下来做什么？", options: ["production"] }]),
    );

    typeCustomAnswer(container, "/multitask");
    act(() => findButton(container, COPY.submit).click());
    expect(responses).toEqual([{ questionId: "iqa_1", answers: ["/multitask"] }]);

    const submitting = findButton(container, COPY.submitting);
    expect(submitting.disabled).toBe(true);
    expect(customInput(container).disabled).toBe(true);

    act(() => submitting.click());
    act(() => findButton(container, COPY.submitting).click());
    expect(responses).toHaveLength(1);
    act(() => root.unmount());
  });

  // 业务意图：提交后问题投影未消失（WS 静默失败 / 服务端 CAS 未生效）时必须给出重试出口，
  // 不能让提交按钮永久置灰——否则用户只能刷新整页、丢掉会话上下文。
  test("提交 15s 未确认：提示未收到确认，提交按钮恢复可用（可重试）", async () => {
    jest.useFakeTimers();
    try {
      const { container, root, responses } = mountPanel(
        pendingQuestion("iqa_1", [{ question: "接下来做什么？", options: ["production"] }]),
      );

      typeCustomAnswer(container, "/multitask");
      act(() => findButton(container, COPY.submit).click());
      expect(findButton(container, COPY.submitting).disabled).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });

      // 提示出现，且提交按钮重新可用（按钮文案回到「提交」，语义即重试）
      expect(container.textContent).toContain(COPY.submitUnconfirmed);
      const retry = findButton(container, COPY.submit);
      expect(retry.disabled).toBe(false);

      // 重试：同一载荷再发一次（服务端 CAS 幂等，重复应答不会产生第二份 control_response）
      act(() => retry.click());
      expect(responses).toEqual([
        { questionId: "iqa_1", answers: ["/multitask"] },
        { questionId: "iqa_1", answers: ["/multitask"] },
      ]);
      act(() => root.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  // 业务意图：多问题卡片里每题的输入互不覆盖（按问题项分键保存），切题来回后文本仍在，
  // 最终载荷按问题顺序逐项对应 requestedSchema 的 properties。
  test("多问题：每题文本独立保存，切换往返不丢失，载荷按问题顺序", () => {
    const { container, root } = mountPanel(
      pendingQuestion("iqa_1", [
        { question: "问题一", options: ["production"] },
        { question: "问题二", options: ["staging"] },
      ]),
    );

    typeCustomAnswer(container, "第一题的回答");
    act(() => findButton(container, COPY.next).click());
    typeCustomAnswer(container, "第二题的回答");

    // 返回上一题：文本与页面同步（分页按钮是纯图标，按无障碍名定位）
    act(() => findButtonByLabel(container, COPY.previous).click());
    expect(customInput(container).value).toBe("第一题的回答");
    expect(container.textContent).toContain("问题一");

    act(() => findButtonByLabel(container, COPY.nextQuestion).click());
    expect(customInput(container).value).toBe("第二题的回答");
    act(() => root.unmount());
  });
});
