import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { agentResources } from "@fenix/agent-config/web/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { AgentEditorSections } from "../pages/agent-panel/agent-editor/AgentEditorSections";
import { AgentResourcePicker } from "../pages/agent-panel/agent-editor/AgentResourcePicker";
import { EditorPagination, EditorStepperField } from "../pages/agent-panel/agent-editor/agent-editor-controls";
import { createAgentEditorDefaults } from "../pages/agent-panel/agent-editor/agent-editor-model";
import type { AgentEditorData } from "../pages/agent-panel/agent-editor/use-agent-editor";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const originalGlobals = new Map(
  [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "CustomEvent",
    "getComputedStyle",
    "MutationObserver",
    "ResizeObserver",
    // Radix 的 Tabs 在挂载后用 `requestAnimationFrame` 解除「首帧不做动画」的抑制，
    // 该函数只存在于 happy-dom 的 Window 上，不显式绑定会让能力分区页签的挂载抛 ReferenceError。
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ].map((key) => [key, globals[key]]),
);
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.HTMLElement = win.HTMLElement;
globals.Element = win.Element;
globals.Node = win.Node;
globals.CustomEvent = win.CustomEvent;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.MutationObserver = win.MutationObserver;
globals.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
Object.defineProperty(win, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  win.document.body.replaceChildren();
});
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function PickerFixture() {
  const [value, setValue] = useState(["alpha"]);
  return (
    <AgentResourcePicker
      label="模型"
      options={[
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
      ]}
      value={value}
      onChange={setValue}
    />
  );
}

function UnavailablePickerFixture() {
  const [value, setValue] = useState(["hidden"]);
  return (
    <AgentResourcePicker
      label="资源"
      options={[
        { id: "available", label: "Available" },
        { id: "hidden", label: "Hidden", unavailable: true },
        { id: "blocked", label: "Blocked", unavailable: true },
      ]}
      value={value}
      onChange={setValue}
    />
  );
}

/** 按点号路径读取字典里的字符串；缺键返回 undefined。 */
function lookup(dictionary: unknown, path: string): string | undefined {
  let current: unknown = dictionary;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * aria-label 的候选取值。
 *
 * 同一份用例在两种 i18n 状态下运行：被测组件的 import 图会初始化宿主 i18n 单例，正常渲染字典译文
 * （`{{name}}` 按资源名展开）；同进程其他测试文件对 `react-i18next` 登记的模块 mock 会残留到后续文件，
 * 此时 `t()` 回显 key。两种取值都要能定位到同一个元素，元素缺失或可点击性回归仍会失败。
 */
function copyCandidates(key: string, values: Record<string, string>): string[] {
  const template = lookup(agentResources.en, key);
  if (template === undefined) return [key];
  const translated = Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    template,
  );
  return [key, translated];
}

/** 元素的 aria-label 是否命中候选取值之一（参数按结构声明，happy-dom 元素不属于 DOM lib 的 `Element`）。 */
function hasLabel(
  element: { getAttribute(name: string): string | null } | undefined,
  candidates: readonly string[],
): boolean {
  return candidates.includes(element?.getAttribute("aria-label") ?? "");
}

function CapabilitiesFixture() {
  const form = useForm({ defaultValues: createAgentEditorDefaults() });
  const data: AgentEditorData = {
    initialValues: createAgentEditorDefaults(),
    agentId: null,
    hindsightEnabled: false,
    sandboxEnabled: false,
    models: [],
    skills: [],
    mcps: [],
    sites: [],
    knowledgeBases: [],
    nodes: [],
    templates: [],
    resourceErrors: [],
  };
  return (
    <AgentEditorSections
      section="capabilities"
      form={form}
      data={data}
      mode="create"
      readOnly={false}
      onCopyAgentId={() => undefined}
    />
  );
}

describe("AgentResourcePicker 组件交互", () => {
  // Stepper 必须限制知识库返回条数边界，并在达到边界时禁用对应操作。
  test("Stepper 限制范围并支持禁用状态", async () => {
    const values: number[] = [];
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root?.render(
        <EditorStepperField
          value={20}
          min={1}
          max={20}
          disabled={false}
          decreaseLabel="decrease"
          increaseLabel="increase"
          onChange={(value) => values.push(value)}
        />,
      ),
    );
    const [decrease, increase] = Array.from(container.querySelectorAll<"button">("button"));
    expect(increase.disabled).toBe(true);
    act(() => decrease.click());
    expect(values).toEqual([19]);
  });

  // 统一分页在只有一页时不渲染，避免每个选择器重复出现无意义分页条。
  test("统一分页仅在多页时显示", async () => {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root?.render(<EditorPagination page={0} pageSize={50} total={2} onPageChange={() => undefined} />),
    );
    expect(container.querySelector("[data-slot=pagination]")).toBeNull();
  });

  // 统一分页使用安全页码计算范围，并只触发一次下一页回调。
  test("统一分页处理页码和翻页", async () => {
    const pages: number[] = [];
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root?.render(<EditorPagination page={0} pageSize={5} total={12} onPageChange={(page) => pages.push(page)} />),
    );
    expect(container.textContent).toContain("1–5 / 12");
    const buttons = Array.from(container.querySelectorAll<"button">("button"));
    expect(buttons[0].disabled).toBe(true);
    act(() => buttons[1].click());
    expect(pages).toEqual([1]);
  });

  // 选择资源只改变选中状态，不得把条目置顶导致指针目标和阅读位置跳动。
  test("选择后保持资源列表顺序", async () => {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => root?.render(<PickerFixture />));
    const labels = () =>
      Array.from(container.querySelectorAll("strong"), (item) => item.textContent).filter(
        (label) => label === "Alpha" || label === "Beta",
      );
    expect(labels()).toEqual(["Alpha", "Beta"]);
    const beta = Array.from(container.querySelectorAll<"button">("button")).find(
      (item) => item.getAttribute("aria-label") === "Beta",
    );
    await act(async () => beta?.click());
    expect(labels()).toEqual(["Alpha", "Beta"]);
  });

  // 必选来源模式不显示“全部来源”，并默认定位已选资源所属来源。
  test("多来源资源库默认定位真实来源", async () => {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root?.render(
        <AgentResourcePicker
          label="Skills"
          groupMode="required"
          options={[
            { id: "a", label: "Alpha", group: { id: "org-a", label: "Org A" } },
            { id: "b", label: "Beta", group: { id: "org-b", label: "Org B" } },
          ]}
          value={["b"]}
          onChange={() => undefined}
        />,
      ),
    );
    expect(container.textContent).not.toContain("editor.allSources");
    expect(container.querySelector("[data-slot=group-filter] [data-active=true]")?.textContent).toContain("Org B");
    expect(container.querySelector("[data-slot=picker-list]")?.textContent).toContain("Beta");
    expect(container.querySelector("[data-slot=picker-list]")?.textContent).not.toContain("Alpha");
  });

  // 只有一个真实分类的 Sites 应退化为平铺结果，不保留无意义来源栏。
  test("单分类资源库隐藏来源栏", async () => {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root?.render(
        <AgentResourcePicker
          label="Sites"
          groupMode="auto"
          options={[{ id: "site", label: "Portal", group: { id: "visibility:org", label: "Organization" } }]}
          value={[]}
          onChange={() => undefined}
        />,
      ),
    );
    expect(container.querySelector("[data-slot=group-filter]")).toBeNull();
    expect(container.querySelector("[data-slot=library-picker]")?.getAttribute("data-flat")).toBe("true");
  });

  // 首次 mount 不得抢走当前焦点，避免编辑工作区打开时焦点被资源选择器截获。
  test("首次渲染不抢焦点", async () => {
    const before = win.document.createElement("button");
    const container = win.document.createElement("div");
    win.document.body.appendChild(before);
    win.document.body.appendChild(container);
    before.focus();
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => root?.render(<PickerFixture />));
    expect(win.document.activeElement).toBe(before);
  });

  // 已绑定 unavailable 项保留明确提示且可移除，未绑定 unavailable 项必须禁用。
  test("unavailable 资源只允许移除", async () => {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => root?.render(<UnavailablePickerFixture />));
    const buttons = Array.from(container.querySelectorAll<"button">("button"));
    const chip = buttons.find((button) => button.getAttribute("data-unavailable") === "true");
    const checkboxes = Array.from(container.querySelectorAll<"button">("button"));
    const removeCandidates = copyCandidates("editor.removeUnavailableResource", { name: "Hidden" });
    const blockedCandidates = copyCandidates("editor.unavailableResource", { name: "Blocked" });
    const hidden = checkboxes.find((checkbox) => hasLabel(checkbox, removeCandidates));
    const blocked = checkboxes.find((checkbox) => hasLabel(checkbox, blockedCandidates));
    expect(hasLabel(chip, removeCandidates), "已绑定 unavailable 项应带「移除」文案").toBe(true);
    expect(hidden?.disabled).toBe(false);
    expect(blocked?.disabled).toBe(true);
    act(() => chip?.click());
    expect(container.querySelector("[data-slot=picker-chips] [data-unavailable=true]")).toBeNull();
  });

  // Capabilities tabs 应建立完整关联，并用左右方向键移动激活项和焦点。
  test("Capabilities tabs 支持 ARIA 关联与方向键", async () => {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => root?.render(<CapabilitiesFixture />));
    const tabs = Array.from(container.querySelectorAll<"button">("button")).filter(
      (button) => button.getAttribute("role") === "tab",
    );
    expect(tabs[0].getAttribute("aria-controls")).toBeTruthy();
    expect(container.querySelector("[role='tabpanel']")?.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    tabs[0].focus();
    // 页签条改走 `ui/tabs`（Radix）后，方向键的聚焦由 RovingFocusGroup 在 `setTimeout` 里落地
    // （`@radix-ui/react-roving-focus` 的 `setTimeout(() => focusFirst(...))`），而 `act` 只 flush
    // microtask；这里补一个宏任务轮次还原真实时序，聚焦触发的 `onFocus → onValueChange` 才会落到渲染上。
    await act(async () => {
      tabs[0].dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(win.document.activeElement?.id).toBe(tabs[1].id);
  });
});
