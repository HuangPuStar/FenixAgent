import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { dispatchWorkspaceSelection, subscribeWorkspaceSelections } from "../lib/workspace-selection-events";

// 相同环境的不同实例也必须隔离，取消只作用于同一目标输入框。
test("delivers a selection and its cancellation only to the target instance", () => {
  const win = new Window();
  const previous = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  const first: unknown[] = [];
  const second: unknown[] = [];
  const stopA = subscribeWorkspaceSelections("env", "a", (value) => first.push(value));
  const stopB = subscribeWorkspaceSelections("env", "b", (value) => second.push(value));
  try {
    dispatchWorkspaceSelection("env", "a", { text: "selected", source: { path: "a.txt" } });
    dispatchWorkspaceSelection("env", "a", null);
    expect(first).toEqual([{ text: "selected", source: { path: "a.txt" } }, null]);
    expect(second).toEqual([]);
  } finally {
    stopA();
    stopB();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
  }
});
