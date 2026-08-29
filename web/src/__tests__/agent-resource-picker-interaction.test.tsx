import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
const win = new Window();
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
    "MutationObserver",
    "ResizeObserver",
  ].map((key) => [key, globals[key]]),
);
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.HTMLElement = win.HTMLElement;
globals.Element = win.Element;
globals.Node = win.Node;
globals.CustomEvent = win.CustomEvent;
globals.MutationObserver = win.MutationObserver;
globals.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
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
    const [decrease, increase] = Array.from(container.querySelectorAll("button"));
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
    expect(container.querySelector(".agent-editor-pagination")).toBeNull();
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
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons[0].disabled).toBe(true);
    act(() => buttons[1].click());
    expect(pages).toEqual([1]);
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
    const buttons = Array.from(container.querySelectorAll("button"));
    const chip = buttons.find((button) => button.classList.contains("is-unavailable"));
    const options = buttons.filter((button) => button.getAttribute("role") === "option");
    expect(chip?.getAttribute("aria-label")).toBe("editor.removeUnavailableResource");
    expect(options.find((option) => option.textContent?.includes("Hidden"))?.disabled).toBe(false);
    expect(options.find((option) => option.textContent?.includes("Blocked"))?.disabled).toBe(true);
    act(() => chip?.click());
    expect(container.querySelector(".agent-resource-picker__chips .is-unavailable")).toBeNull();
  });

  // Capabilities tabs 应建立完整关联，并用左右方向键移动激活项和焦点。
  test("Capabilities tabs 支持 ARIA 关联与方向键", async () => {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => root?.render(<CapabilitiesFixture />));
    const tabs = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.getAttribute("role") === "tab",
    );
    expect(tabs[0].getAttribute("aria-controls")).toBeTruthy();
    expect(container.querySelector("[role='tabpanel']")?.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    tabs[0].focus();
    await act(async () =>
      tabs[0].dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(win.document.activeElement?.id).toBe(tabs[1].id);
  });
});
