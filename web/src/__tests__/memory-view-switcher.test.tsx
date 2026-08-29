import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { List, Network } from "lucide-react";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryViewSwitcher } from "../pages/hindsight/components/MemoryViewSwitcher";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = new Window();
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = win.document;

function SwitcherFixture() {
  const [value, setValue] = useState<"graph" | "list">("graph");
  return (
    <MemoryViewSwitcher<"graph" | "list">
      value={value}
      onValueChange={setValue}
      ariaLabel="记忆视图"
      options={[
        { value: "graph", label: "图谱", icon: Network },
        { value: "list", label: "列表", icon: List },
      ]}
    />
  );
}

describe("MemoryViewSwitcher", () => {
  // 切换器必须暴露分组名称、选中状态，并能通过按钮更新选择。
  test("提供可访问选择语义并响应点击", () => {
    const container = win.document.createElement("div") as unknown as HTMLElement;
    const root = createRoot(container);
    act(() => root.render(createElement(SwitcherFixture)));

    const group = container.querySelector('[role="group"]');
    const buttons = container.querySelectorAll("button");
    expect(group?.getAttribute("aria-label")).toBe("记忆视图");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");

    act(() => (buttons[1] as HTMLButtonElement).click());
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
    act(() => root.unmount());
  });
});
