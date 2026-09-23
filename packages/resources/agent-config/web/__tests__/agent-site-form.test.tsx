// web/__tests__/agent-site-form.test.tsx
// 「新建 / 编辑应用」弹窗字段体的取值与校验（第 17 轮 §4.3）。
//
// 被钉住的运行时行为，读源码断言不到：
//   1. 必填缺失时提交被 zod 拦下，错误**落在名称字段上**。此前这条校验写在请求体构造里
//      （`if (!name.trim()) throw new Error(t("siteDeployment.errors.nameRequired"))`），
//      异常被 `useRequest` 的 `onError` 接成通用的「保存应用失败」toast——用户看到的是保存失败，
//      而不是「名称不能为空」；
//   2. 名称合法时提交把值交给回调（可见范围按默认值）；
//   3. 换 `key` 重挂载后，上一次的校验错误不残留，字段渲染的是新表单实例的默认值
//      （新建 → 空名称，编辑 → 带出该应用的名称与可见范围）。
//
// 环境：happy-dom + react-dom/client。两条已知限制与应对（都不影响上面三点的覆盖）：
//   - **不渲染 Radix `Dialog`**：portal 会撞 `@radix-ui/react-focus-scope` 的一串缺失全局
//     （NodeFilter / HTMLInputElement …）。因此这里只渲染字段体，用 `FormProvider` 复刻
//     `FormDialog` 内部「`useForm` 在对话框内部创建、生命周期由 `key` 控制」的形态。
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
const { AgentSiteForm, agentSiteFormSchema } = await import("../pages/agent-panel/components/AgentSiteForm");

type FormValues = { name: string; description: string; visibility: "private" | "org" | "authenticated" | "public" };

/** 新建态的默认值，与页面 `formConfig.defaultValues` 的新建分支同形。 */
const CREATE_DEFAULTS: FormValues = { name: "", description: "", visibility: "private" };

const submitted: FormValues[] = [];

/**
 * 复刻 `FormDialog` 的内部形态：`useForm` 在「对话框」内部创建，字段体经 `FormProvider` 取用。
 * 提交按钮由外壳提供（真实形态里它在 `DialogFooter`），这里补一个同形的 submit 入口。
 */
function Harness({ defaults }: { defaults: FormValues }) {
  const methods = useForm<FormValues>({
    resolver: zodResolver(agentSiteFormSchema),
    defaultValues: defaults,
  });
  return createElement(
    FormProvider,
    methods,
    createElement(
      "form",
      { onSubmit: methods.handleSubmit((values) => submitted.push(values)) },
      createElement(AgentSiteForm),
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

/** 名称字段所在的行里是否有错误行（错误必须落在该字段上，而不是只出现一处）。 */
function nameFieldHasAlert(): boolean {
  return (input("#site-name").closest("div")?.querySelectorAll('[role="alert"]').length ?? 0) > 0;
}

describe("AgentSiteForm 的校验", () => {
  // 必填缺失必须在名称字段上可见：此前异常被 onError 接成通用的「保存应用失败」，真正的原因
  // （名称不能为空）被吞掉，用户只能反复猜。
  test("名称留空时提交被拦下：不触发提交回调，错误落在名称字段上", async () => {
    await render(createElement(Harness, { defaults: CREATE_DEFAULTS }));
    await submit();

    expect(submitted).toEqual([]);
    expect(alertCount()).toBe(1);
    expect(nameFieldHasAlert()).toBe(true);
  });

  // 纯空白同样算缺失（schema 的 `trim()`），否则后端会收到一个只有空格的名称。
  test("名称只有空白时同样被拦下", async () => {
    await render(createElement(Harness, { defaults: { ...CREATE_DEFAULTS, name: "   " } }));
    await submit();

    expect(submitted).toEqual([]);
    expect(nameFieldHasAlert()).toBe(true);
  });

  // 合法取值必须真的走到提交回调——否则「拦下非法」与「什么都拦下」在用例里同形。
  test("名称合法时提交把值交给回调，错误行为零", async () => {
    await render(createElement(Harness, { defaults: { name: "my-app", description: "说明", visibility: "org" } }));
    await submit();

    expect(submitted).toEqual([{ name: "my-app", description: "说明", visibility: "org" }]);
    expect(alertCount()).toBe(0);
  });
});

describe("AgentSiteForm 的取值", () => {
  // 新建态的默认值：名称与描述为空、可见范围为「仅自己」，并原样随提交回传。
  // 描述与可见范围不看呈现（`Textarea` 在跨文件运行时会拿到别的用例注册的进程级替身，
  // `SelectValue` 的文本又依赖内容层挂载），改由「提交回传的取值」证明它们绑在表单实例上。
  test("新建默认值为空名称（名称填齐后描述与可见范围随提交原样回传）", async () => {
    await render(createElement(Harness, { defaults: CREATE_DEFAULTS }));
    expect(input("#site-name").value).toBe("");
    expect(alertCount()).toBe(0);

    // 换 key 挂上「名称填齐」的那一份默认值（同 key 的再渲染只更新 props，`useForm` 不会重读
    // `defaultValues`——这正是页面必须靠 `key` 而不是改 props 来重置表单的原因）
    await render(
      createElement(Harness, {
        key: 2,
        defaults: { name: "my-app", description: "", visibility: "private" },
      }),
    );
    await submit();
    expect(submitted).toEqual([{ name: "my-app", description: "", visibility: "private" }]);
  });

  // 换 key = 换表单实例（与页面每次打开自增 `formResetKey` 等价）：编辑目标换了，字段必须跟着新实例走。
  test("换 key 重挂载后字段取自新表单实例的默认值，不沿用上一份", async () => {
    await render(createElement(Harness, { key: 1, defaults: CREATE_DEFAULTS }));
    expect(input("#site-name").value).toBe("");

    await render(createElement(Harness, { key: 2, defaults: { name: "my-app", description: "", visibility: "org" } }));
    expect(input("#site-name").value).toBe("my-app");
    await submit();
    expect(submitted).toEqual([{ name: "my-app", description: "", visibility: "org" }]);
  });

  // 「关闭后不残留校验错误」：先制造一次校验失败，再换 key 重挂载（= 重新打开对话框），错误行必须消失。
  test("换 key 重挂载后上一次的校验错误不残留", async () => {
    await render(createElement(Harness, { key: 1, defaults: CREATE_DEFAULTS }));
    await submit();
    expect(alertCount()).toBe(1);

    await render(createElement(Harness, { key: 2, defaults: CREATE_DEFAULTS }));
    expect(alertCount()).toBe(0);
  });

  // schema 是「合不合法」的唯一判据（字段体只按字段取文案）：空名称、纯空白名称要被拒，
  // 合法的可见范围枚举要放行。这条不依赖 DOM，键盘输入受限也能把规则钉死。
  test("schema 拒绝空与纯空白的名称，放行四个可见范围", () => {
    expect(agentSiteFormSchema.safeParse({ name: "", description: "", visibility: "private" }).success).toBe(false);
    expect(agentSiteFormSchema.safeParse({ name: "  ", description: "", visibility: "private" }).success).toBe(false);
    for (const visibility of ["private", "org", "authenticated", "public"] as const) {
      expect(agentSiteFormSchema.safeParse({ name: "my-app", description: "", visibility }).success).toBe(true);
    }
  });
});
