// web/__tests__/plugin-market-publish-form.test.tsx
// 发布弹窗字段体的取值、校验与锁定（§4.3）。
//
// 被钉住的运行时行为，读源码断言不到：
//   1. 字段值全部经 `useFormContext()` 从表单实例取，字段体**自己一个 `useState` 都没有**——这是
//      「容器按『每次打开换一个 `key`』渲染 `FormDialog`，重挂载即表单干净」这个前提的成立条件；
//   2. 必填缺失时提交被 zod 拦下：提交回调一次都不触发，错误**落在对应字段上**——此前是两个输入框各自
//      `useState` + 一段手写 `validatePublishTarget`，错误只能落在弹窗底部的一条通用提示里，字段本身没有
//      任何标记，也看不出是哪一个没填（该函数已随本次改造删除）；
//   3. 换 `key` 重挂载后，上一次的校验错误不残留；
//   4. 已有预览时两个字段被锁定（`disabled`）：此时「确认发布」确认的是**预览那一份**的定位符，放开输入
//      会让界面展示 A、实际发布 B。
//
// 环境：happy-dom + react-dom/client，两条已知限制与应对（都不影响上面四点的覆盖）：
//   - **不渲染 Radix `Dialog`**：portal 会撞 `@radix-ui/react-focus-scope` 的一串缺失全局。因此这里只渲染
//     字段体，用 `FormProvider` 复刻 `FormDialog` 内部「`useForm` 在对话框内部创建、生命周期由 `key` 控制」
//     的形态；被测对象是表单的取值与校验，不是弹窗外壳。
//   - **不模拟键盘输入**：happy-dom 下 React 的 `ChangeEventPlugin` 认不出合成值变更（`onInput` 会触发、
//     `onChange` 不会），`register` 绑的正是 `onChange`。因此用例一律从 `defaultValues` 侧驱动，
//     需要「用户改过字段」的场景改由 schema 直测覆盖。
// 断言口径：只看行为与结构（提交回调次数、错误行是否存在、输入框当前值与 `disabled`），不对译文做断言，
// 因而与本进程其他文件注册的 `react-i18next` 替身互不耦合。

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
const { PluginPublishForm, pluginPublishFormSchema } = await import(
  "../pages/agent-panel/components/plugin-market-publish-form"
);

type FormValues = { packageName: string; exactVersion: string };

/** 与页面 `formConfig.defaultValues` 同形：两个定位符都留空，全部靠用户填。 */
const EMPTY: FormValues = { packageName: "", exactVersion: "" };

const submitted: FormValues[] = [];

/**
 * 复刻 `FormDialog` 的内部形态：`useForm` 在「对话框」内部创建，字段体经 `FormProvider` 取用。
 * 提交按钮由外壳提供（真实形态里它在 `DialogFooter`），这里补一个同形的 submit 入口。
 */
function Harness({ defaults, locked = false }: { defaults: FormValues; locked?: boolean }) {
  const methods = useForm<FormValues>({
    resolver: zodResolver(pluginPublishFormSchema),
    defaultValues: defaults,
  });
  return createElement(
    FormProvider,
    methods,
    createElement(
      "form",
      { onSubmit: methods.handleSubmit((values) => submitted.push(values)) },
      createElement(PluginPublishForm, { locked }),
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

const PACKAGE_INPUT = "#plugin-market-publish-package-name";
const VERSION_INPUT = "#plugin-market-publish-exact-version";

describe("PluginPublishForm 的取值", () => {
  // 字段默认值只能来自表单实例：字段体若自持 state，容器「换 key 重挂载」就不再等于「表单干净」。
  test("两个字段的默认值都来自表单实例，并原样随提交回传", async () => {
    await render(createElement(Harness, { defaults: { packageName: "@acme/investment-team", exactVersion: "1.2.0" } }));

    expect(input(PACKAGE_INPUT).value).toBe("@acme/investment-team");
    expect(input(VERSION_INPUT).value).toBe("1.2.0");
    expect(alertCount()).toBe(0);
    await submit();
    expect(submitted).toEqual([{ packageName: "@acme/investment-team", exactVersion: "1.2.0" }]);
  });

  // 换 key = 换表单实例（与容器每次打开自增 `publishKey` 等价）：取值必须跟着新实例走。
  test("换 key 重挂载后字段取自新表单实例的默认值", async () => {
    await render(createElement(Harness, { key: 1, defaults: { packageName: "@acme/a", exactVersion: "1.0.0" } }));
    await submit();
    expect(submitted).toEqual([{ packageName: "@acme/a", exactVersion: "1.0.0" }]);

    submitted.length = 0;
    await render(createElement(Harness, { key: 2, defaults: EMPTY }));
    expect(input(PACKAGE_INPUT).value).toBe("");
    expect(input(VERSION_INPUT).value).toBe("");
  });

  // 锁定只在「已有预览」时生效：正常填写阶段字段必须可用，否则用户没法填第一个字。
  test("未锁定时两个字段都可编辑", async () => {
    await render(createElement(Harness, { defaults: EMPTY }));

    expect(input(PACKAGE_INPUT).disabled).toBe(false);
    expect(input(VERSION_INPUT).disabled).toBe(false);
  });

  // 已有预览 = 定位符已冻结（确认发布取的是预览自带的取值）：两个字段都必须锁上，不能只锁包名。
  test("锁定后两个字段都被禁用", async () => {
    await render(createElement(Harness, { defaults: { packageName: "@acme/a", exactVersion: "1.0.0" }, locked: true }));

    expect(input(PACKAGE_INPUT).disabled).toBe(true);
    expect(input(VERSION_INPUT).disabled).toBe(true);
  });
});

describe("PluginPublishForm 的校验", () => {
  // 必填缺失必须在字段上可见：此前只落一条弹窗底部的通用提示，提交处理函数仍会被调用（或在里面静默 return）。
  test("包名留空时提交被拦下：不触发提交回调，错误落在包名字段上", async () => {
    await render(createElement(Harness, { defaults: { packageName: "", exactVersion: "1.0.0" } }));
    await submit();

    expect(submitted).toEqual([]);
    expect(alertCount()).toBe(1);
    expect(fieldHasAlert(PACKAGE_INPUT)).toBe(true);
  });

  // 精确版本走同一个判据（此前两个字段共用一条提示，缺哪一个无法分别指出）。
  test("精确版本留空时提交被拦下：错误落在版本字段上，不会静默通过", async () => {
    await render(createElement(Harness, { defaults: { packageName: "@acme/a", exactVersion: "" } }));
    await submit();

    expect(submitted).toEqual([]);
    expect(alertCount()).toBe(1);
    expect(fieldHasAlert(VERSION_INPUT)).toBe(true);
  });

  // 「关闭后不残留校验错误」：先制造一次校验失败，再换 key 重挂载（= 重新打开对话框），错误行必须消失。
  test("换 key 重挂载后上一次的校验错误不残留", async () => {
    const broken: FormValues = { packageName: "", exactVersion: "1.0.0" };
    await render(createElement(Harness, { key: 1, defaults: broken }));
    await submit();
    expect(alertCount()).toBe(1);

    await render(createElement(Harness, { key: 2, defaults: broken }));
    expect(alertCount()).toBe(0);
  });

  // 合法取值必须真的走到提交回调，并且提交的是 schema 归一后的值（两个定位符都去掉了首尾空白）——
  // 否则「拦下非法」与「什么都拦下」在用例里同形，且预览会拿带空白的包名去拼请求。
  test("两个必填都合法时提交把归一后的值交给回调", async () => {
    await render(createElement(Harness, { defaults: { packageName: "  @acme/a  ", exactVersion: " 1.0.0 " } }));
    await submit();

    expect(submitted).toEqual([{ packageName: "@acme/a", exactVersion: "1.0.0" }]);
    expect(alertCount()).toBe(0);
  });

  // schema 是「合不合法」的唯一判据（字段体只按字段取文案）：纯全空、纯空白都要被拒。
  // 这条不依赖 DOM，因此键盘输入受限也能把规则钉死。
  test("schema 拒绝空值与纯空白，放行合法组合", () => {
    expect(pluginPublishFormSchema.safeParse(EMPTY).success).toBe(false);
    expect(pluginPublishFormSchema.safeParse({ packageName: "   ", exactVersion: "1.0.0" }).success).toBe(false);
    expect(pluginPublishFormSchema.safeParse({ packageName: "@acme/a", exactVersion: "   " }).success).toBe(false);
    expect(pluginPublishFormSchema.safeParse({ packageName: "@acme/a", exactVersion: "1.0.0" }).success).toBe(true);
  });
});
