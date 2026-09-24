// web/__tests__/channel-binding-form.test.tsx
// 「新建通道绑定」弹窗字段体的取值与校验（第 17 轮 §4.3）。
//
// 被钉住的运行时行为，读源码断言不到：
//   1. 字段值全部经 `useFormContext()` 从表单实例取，字段体**自己一个 `useState` 都没有**——这是
//      「页面按『每次打开换一个 `key`』渲染 `FormDialog`，重挂载即表单干净」这个前提的成立条件；
//   2. 必填缺失时提交被 zod 拦下：提交回调一次都不触发，错误**落在对应字段上**——此前是
//      `if (!formPlatform.trim() || !formAgentId) toast.error(...)`，错误只飘在右下角，字段本身没有
//      任何标记，也看不出是哪一个没填；
//   3. 换 `key` 重挂载后，上一次的校验错误不残留，字段渲染的是新表单实例的默认值。
//
// 环境：happy-dom + react-dom/client。两条已知限制与应对（都不影响上面三点的覆盖）：
//   - **不渲染 Radix `Dialog`**：portal 会撞 `@radix-ui/react-focus-scope` 的一串缺失全局
//     （NodeFilter / HTMLInputElement …）。因此这里只渲染字段体，用 `FormProvider` 复刻
//     `FormDialog` 内部「`useForm` 在对话框内部创建、生命周期由 `key` 控制」的形态；被测对象是表单的
//     取值与校验，不是弹窗外壳。
//   - **不模拟键盘输入**：happy-dom 下 React 的 `ChangeEventPlugin` 认不出合成值变更（`onInput` 会触发、
//     `onChange` 不会），`register` 绑的正是 `onChange`。因此用例一律从 `defaultValues` 侧驱动，
//     需要「用户改过字段」的场景改由 schema 直测覆盖。
// 断言口径：只看行为与结构（提交回调次数、错误行是否存在、输入框当前值、Select 触发器文本），
// 不对译文做断言，因而与本进程其他文件注册的 `react-i18next` 替身互不耦合。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
// Radix 组件的提交阶段会读一批标准 DOM 全局（happy-dom 只把它们挂在 Window 实例上）。`customElements`
// 必须与 `HTMLElement` 成对注入——只给后者会让 `@pierre/diffs` 的「有 DOM 前提成立、customElements
// 仍为 undefined」形态崩在后续文件的模块求值期（见 `@fenix/ui-components/testing` 的文件头）。
for (const key of [
  "HTMLElement",
  "customElements",
  "Element",
  "Node",
  "CustomEvent",
  "DocumentFragment",
  "MutationObserver",
  "ResizeObserver",
]) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined) g[key] = value;
}
g.getComputedStyle = win.getComputedStyle.bind(win);

const { FormProvider, useForm } = await import("react-hook-form");
const { zodResolver } = await import("@hookform/resolvers/zod");
const { ChannelBindingForm, channelBindingFormSchema } = await import(
  "../pages/agent-panel/components/ChannelBindingForm"
);

type FormValues = { platform: string; chatId: string; agentId: string };

const ENVIRONMENTS = [
  { id: "env-1", name: "环境一" },
  { id: "env-2", name: "环境二" },
];

/** 默认值与页面 `formConfig.defaultValues` 同形：平台/会话留空，agent 预选首个环境。 */
function defaultsFor(agentId: string): FormValues {
  return { platform: "", chatId: "", agentId };
}

/** 供「提交真的走到底」的用例使用：必填填齐，只变化 agent 以观察取出的是哪一份默认值。 */
function submittableFor(agentId: string, platform = "wechat"): FormValues {
  return { platform, chatId: "", agentId };
}

const submitted: FormValues[] = [];

/**
 * 复刻 `FormDialog` 的内部形态：`useForm` 在「对话框」内部创建，字段体经 `FormProvider` 取用。
 * 提交按钮由外壳提供（真实形态里它在 `DialogFooter`），这里补一个同形的 submit 入口。
 */
function Harness({ defaults }: { defaults: FormValues }) {
  const methods = useForm<FormValues>({
    resolver: zodResolver(channelBindingFormSchema),
    defaultValues: defaults,
  });
  return createElement(
    FormProvider,
    methods,
    createElement(
      "form",
      { onSubmit: methods.handleSubmit((values) => submitted.push(values)) },
      createElement(ChannelBindingForm, { environments: ENVIRONMENTS }),
      createElement("button", { type: "submit" }, "submit"),
    ),
  );
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  submitted.length = 0;
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例的做法一次性收窄
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

/** 渲染并等待 react-hook-form 的提交链与随后的重渲染落定。 */
async function render(node: ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 按 id 取输入框；找不到即用例写错（比断言 undefined 更早暴露）。 */
function input(selector: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(selector);
  if (!element) throw new Error(`输入框未渲染：${selector}`);
  return element;
}

/** 点提交并等待 zodResolver 的校验与重渲染。 */
async function submit(): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) throw new Error("提交按钮未渲染");
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 当前渲染出的校验错误行（字段体内的 `role="alert"`）。 */
function alertCount(): number {
  return container.querySelectorAll('[role="alert"]').length;
}

/** 某个字段所在的表单行里是否有错误行（错误必须落在对应字段上，而不是只出现一处）。 */
function fieldHasAlert(selector: string): boolean {
  const field = container.querySelector(selector);
  return (field?.closest("div")?.querySelectorAll('[role="alert"]').length ?? 0) > 0;
}

describe("ChannelBindingForm 的取值", () => {
  // 字段默认值只能来自表单实例：字段体若自持 state，页面「换 key 重挂载」就不再等于「表单干净」。
  test("三个字段的默认值都来自表单实例，并原样随提交回传", async () => {
    await render(createElement(Harness, { defaults: { platform: "wechat", chatId: "chat-1", agentId: "env-1" } }));

    expect(input("#channel-binding-platform").value).toBe("wechat");
    expect(input("#channel-binding-chat-id").value).toBe("chat-1");
    expect(alertCount()).toBe(0);
    // agent 走 Radix Select，取值不看呈现（`SelectValue` 的文本依赖内容层挂载，跨文件运行时不稳），
    // 改由「提交回传的取值」证明它绑在表单实例上
    await submit();
    expect(submitted).toEqual([{ platform: "wechat", chatId: "chat-1", agentId: "env-1" }]);
  });

  // 换 key = 换表单实例（与页面每次打开自增 `formResetKey` 等价）：取值必须跟着新实例走。
  test("换 key 重挂载后字段取自新表单实例的默认值", async () => {
    await render(createElement(Harness, { key: 1, defaults: submittableFor("env-1") }));
    await submit();
    expect(submitted).toEqual([{ platform: "wechat", chatId: "", agentId: "env-1" }]);

    submitted.length = 0;
    await render(createElement(Harness, { key: 2, defaults: submittableFor("env-2") }));
    await submit();
    expect(submitted).toEqual([{ platform: "wechat", chatId: "", agentId: "env-2" }]);
  });
});

describe("ChannelBindingForm 的校验", () => {
  // 必填缺失必须在字段上可见：此前只 toast 一句「请选择平台和 Agent」，提交处理函数仍然会被调用。
  test("平台留空时提交被拦下：不触发提交回调，错误落在平台字段上", async () => {
    await render(createElement(Harness, { defaults: defaultsFor("env-1") }));
    await submit();

    expect(submitted).toEqual([]);
    expect(alertCount()).toBe(1);
    expect(fieldHasAlert("#channel-binding-platform")).toBe(true);
  });

  // agent 为空走同一个判据（此前它与平台共用一条 toast，两个字段的缺失无法分别提示）。
  test("未选中 agent 时提交被拦下：错误落在 agent 字段上，不会静默通过", async () => {
    await render(createElement(Harness, { defaults: { platform: "wechat", chatId: "", agentId: "" } }));
    await submit();

    expect(submitted).toEqual([]);
    expect(alertCount()).toBe(1);
    expect(fieldHasAlert("#channel-binding-agent")).toBe(true);
  });

  // 「关闭后不残留校验错误」：先制造一次校验失败，再换 key 重挂载（= 重新打开对话框），错误行必须消失。
  test("换 key 重挂载后上一次的校验错误不残留", async () => {
    await render(createElement(Harness, { key: 1, defaults: defaultsFor("env-1") }));
    await submit();
    expect(alertCount()).toBe(1);

    await render(createElement(Harness, { key: 2, defaults: defaultsFor("env-1") }));
    expect(alertCount()).toBe(0);
  });

  // 合法取值必须真的走到提交回调，并且提交的是 schema 归一后的值（`platform` 去掉了首尾空白）——
  // 否则「拦下非法」与「什么都拦下」在用例里同形。
  test("两个必填都合法时提交把归一后的值交给回调", async () => {
    await render(createElement(Harness, { defaults: { platform: "  wechat  ", chatId: "chat-1", agentId: "env-1" } }));
    await submit();

    expect(submitted).toEqual([{ platform: "wechat", chatId: "chat-1", agentId: "env-1" }]);
    expect(alertCount()).toBe(0);
  });

  // schema 是「合不合法」的唯一判据（字段体只按字段取文案）：纯全空、纯空白、缺 agent 都要被拒。
  // 这条不依赖 DOM，因此键盘输入受限也能把规则钉死。
  test("schema 拒绝纯空白与缺失的必填，放行合法组合", () => {
    expect(channelBindingFormSchema.safeParse({ platform: "   ", chatId: "", agentId: "env-1" }).success).toBe(false);
    expect(channelBindingFormSchema.safeParse({ platform: "wechat", chatId: "", agentId: "" }).success).toBe(false);
    expect(channelBindingFormSchema.safeParse({ platform: "wechat", chatId: "", agentId: "env-1" }).success).toBe(true);
  });
});
