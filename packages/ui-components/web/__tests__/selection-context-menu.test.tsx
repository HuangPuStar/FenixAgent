import { afterAll, afterEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { SelectionContextMenu } from "../components/selection-context-menu";
import { hitsVisibleTextSelection, readDomTextSelection } from "../components/text-selection";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { usePageFullscreen } from "../ui/use-page-fullscreen";

const savedGlobals = new Map(
  [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "IS_REACT_ACT_ENVIRONMENT",
  ].map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
);
afterAll(() => {
  for (const [key, value] of savedGlobals) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});
const i18n = createInstance();
void i18n.init({
  lng: "en",
  initAsync: false,
  defaultNS: UI_COMPONENTS_NS,
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});
const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
])
  globals[name] = name === "window" ? win : (win as unknown as Record<string, unknown>)[name];
globals.IS_REACT_ACT_ENVIRONMENT = true;
function Menu(props: Parameters<typeof SelectionContextMenu>[0]) {
  return (
    <I18nextProvider i18n={i18n}>
      <SelectionContextMenu {...props} />
    </I18nextProvider>
  );
}
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  win.document.body.replaceChildren();
});

// 菜单必须使用右键时的快照，不能在焦点移动后引用另一段内容。
test("quotes the captured selection and closes without changing document contents", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  let text = "  first\n    line";
  const received: string[] = [];
  act(() =>
    root?.render(
      <Menu onQuote={(selection) => received.push(selection.text)} readSelection={() => ({ text })}>
        <p>Original file</p>
      </Menu>,
    ),
  );
  const event = new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  act(() => host.querySelector("p")?.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  text = "changed selection";
  const add = document.querySelector<HTMLButtonElement>('[data-selection-action="quote"]');
  expect(add).not.toBeNull();
  act(() => add?.click());
  expect(received).toEqual(["  first\n    line"]);
  expect(host.textContent).toBe("Original file");
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

// 无选区和隐藏文件不能接管浏览器原菜单。
test("leaves native menu untouched without a valid active selection", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <Menu onQuote={() => {}} readSelection={() => null}>
        <p>file</p>
      </Menu>,
    ),
  );
  const event = new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  act(() => host.querySelector("p")?.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

// 浏览器禁止剪贴板或不提供 Clipboard API 时，保留菜单并明确显示复制失败。
test("shows copy failure when the clipboard API is unavailable", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  act(() =>
    root?.render(
      <Menu onQuote={() => {}} readSelection={() => ({ text: "selected" })}>
        <p>file</p>
      </Menu>,
    ),
  );
  act(() =>
    host.querySelector("p")?.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] button')?.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not copy the selected text");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
});

// 留在另一个文件中的选区不属于本文件，不能被右键错误引用。
test("rejects a DOM selection outside the current file", () => {
  const first = document.createElement("p");
  first.textContent = "first file";
  const second = document.createElement("p");
  second.textContent = "second file";
  document.body.append(first, second);
  const range = document.createRange();
  range.selectNodeContents(first);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  const event = new win.MouseEvent("contextmenu") as unknown as MouseEvent;
  expect(readDomTextSelection(second, event)).toBeNull();
  expect(readDomTextSelection(first, event)).toEqual({ text: "first file" });
});

// 编辑器会把空白位置吸附到最近字符，只有实际绘制的选区能接管鼠标右键。
test("rejects clicks in blank space outside the painted editor selection", () => {
  const editor = document.createElement("div");
  const painted = document.createElement("div");
  painted.className = "cm-selectionBackground";
  painted.getBoundingClientRect = () => new win.DOMRect(10, 20, 80, 18);
  editor.append(painted);
  document.body.append(editor);
  const gesture = (x: number) =>
    new win.MouseEvent("contextmenu", { clientX: x, clientY: 25, button: 2 }) as unknown as MouseEvent;
  expect(hitsVisibleTextSelection(editor, gesture(50), ".cm-selectionBackground")).toBe(true);
  expect(hitsVisibleTextSelection(editor, gesture(200), ".cm-selectionBackground")).toBe(false);
});

// Escape 应先关闭选区菜单，全屏必须保留到下一次 Escape。
test("Escape closes the selection menu before leaving page fullscreen", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function FullscreenProbe() {
    const full = usePageFullscreen();
    return (
      <div data-fullscreen={full.fullscreen}>
        <button type="button" onClick={full.toggleFullscreen}>
          Full
        </button>
        <Menu onQuote={() => {}} readSelection={() => ({ text: "selected" })}>
          <p>file</p>
        </Menu>
      </div>
    );
  }
  act(() => root?.render(<FullscreenProbe />));
  act(() => host.querySelector("button")?.click());
  act(() =>
    host.querySelector("p")?.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  const item = document.querySelector('[role="menuitem"]');
  act(() => item?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(host.querySelector("[data-fullscreen]")?.getAttribute("data-fullscreen")).toBe("true");
});

// 隐藏或移除引用能力必须撤销 body 中的菜单，重新激活不能复活旧快照。
test("removing the quote callback immediately removes a portal menu", () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <Menu onQuote={() => {}} readSelection={() => ({ text: "selected" })}>
        <p>file</p>
      </Menu>,
    ),
  );
  act(() =>
    host.querySelector("p")?.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  act(() =>
    root?.render(
      <Menu readSelection={() => ({ text: "selected" })}>
        <p>file</p>
      </Menu>,
    ),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
