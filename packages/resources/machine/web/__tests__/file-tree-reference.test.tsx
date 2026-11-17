import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ChatComposer } from "@fenix/ui-components/chat/composer/ChatComposer";
import type { ComposerExternalEvent } from "@fenix/ui-components/chat/composer/composer-effects";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import * as fileEvents from "../api/file-events";
import { fsApi } from "../api/fs";
import { FileTreeTab } from "../components/FileTreeTab";
import { MACHINE_NS, machineResources } from "../i18n";

const win = initializeHappyDomWindow(new Window({ url: "http://localhost" }));
const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Image",
  "Node",
  "MutationObserver",
  "ResizeObserver",
  "customElements",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = new Map(keys.map((key) => [key, globals[key]]));
const i18n = createInstance();
await i18n.init({
  lng: "zh",
  initAsync: false,
  defaultNS: MACHINE_NS,
  resources: { zh: { [MACHINE_NS]: machineResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh } },
});

// 只替换文件服务网络边界，保留真实文件树、选择、菜单和引用回调接线。
const treeSpy = spyOn(fsApi, "tree");
const eventsSpy = spyOn(fileEvents, "openFileEventsConnection").mockReturnValue({
  isOpen: () => true,
  close: () => {},
});
let root: Root;
let host: HTMLElement;
let references: Array<{ path: string; name: string }>;
let submitted = false;

beforeEach(() => {
  for (const key of keys)
    globals[key] = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (win as unknown as Record<string, unknown>)[key];
  globals.window = win;
  globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  Object.defineProperty(win.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 320 });
  host = win.document.createElement("div");
  win.document.body.append(host);
  root = createRoot(host);
  references = [];
  submitted = false;
  treeSpy.mockResolvedValue({ success: true, data: { paths: ["a.md", "b.md", "docs/note.md", "user/c.md"] } });
});
afterEach(() => {
  act(() => root.unmount());
  win.document.body.innerHTML = "";
});
afterAll(() => {
  treeSpy.mockRestore();
  eventsSpy.mockRestore();
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 挂载真实业务组件，等待初始文件树请求完成。 */
async function render(withComposer = false) {
  let emit: ((event: ComposerExternalEvent) => void) | undefined;
  await act(async () =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <FileTreeTab
          envId="env-a"
          onPreviewFile={() => {}}
          onFilesChanged={() => {}}
          onReferenceFile={(path, name) => {
            references.push({ path, name });
            emit?.({ type: "file-reference", file: { path, name } });
          }}
        />
        {withComposer && (
          <ChatComposer
            defaultDraft="请一起检查"
            onSubmit={() => {
              submitted = true;
            }}
            subscribeExternal={(handler) => {
              emit = handler;
              return () => {
                emit = undefined;
              };
            }}
          />
        )}
      </I18nextProvider>,
    ),
  );
}

/** 用户操作必须命中真实条目，缺失时直接失败。 */
function row(path: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[data-tree-item][data-node-id="${path}"]`);
  if (!element) throw new Error(`Missing tree row: ${path}`);
  return element;
}

/** 通过真实 DOM 事件选择，保留 Cmd/Ctrl 的增选语义。 */
function select(path: string, ctrlKey = false) {
  act(() => row(path).dispatchEvent(new win.MouseEvent("click", { bubbles: true, ctrlKey })));
}

/** 引用菜单由右键选中快照决定，打开菜单自身不得触发引用。 */
function reference(path: string) {
  const previous = [...references];
  act(() => row(path).dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
  expect(references).toEqual(previous);
  const item = Array.from(win.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (element) => element.textContent === uiComponentsResources.zh.fileTree.contextMenu.reference,
  );
  expect(item).toBeDefined();
  act(() => item?.click());
  expect(win.document.querySelector('[role="menu"]')).toBeNull();
}

// 多选中右键已选项应引用整组，且保留两个条目的选中状态。
test("多选右键引用整组并保留选择", async () => {
  await render();
  select("a.md");
  select("b.md", true);
  reference("a.md");
  expect(references).toEqual([
    { path: "a.md", name: "a.md" },
    { path: "b.md", name: "b.md" },
  ]);
  expect(row("a.md").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");
  expect(row("b.md").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");
});

// 右键未选项应先替换选择，引用不能误带上之前的整组。
test("右键未选项仅引用该项", async () => {
  await render();
  select("a.md");
  select("b.md", true);
  reference("user/c.md");
  expect(references).toEqual([{ path: "user/c.md", name: "c.md" }]);
});

// 文件夹引用复用原路径语义，不能自动展开为所有后代文件。
test("文件夹与文件一起引用时只传明确选中的路径", async () => {
  await render();
  select("a.md");
  select("docs", true);
  reference("docs");
  expect(references).toEqual([
    { path: "a.md", name: "a.md" },
    { path: "docs", name: "docs" },
  ]);
});

// 跨分区的整组引用应连续加入真实输入框，保留草稿和已有附件，重复点击不重复追加。
test("批量引用追加到聊天并去重，不自动发送", async () => {
  await render(true);
  select("a.md");
  reference("a.md");
  select("b.md", true);
  select("user/c.md", true);
  reference("a.md");
  reference("user/c.md");
  expect(host.querySelector("textarea")?.value).toBe("请一起检查 @./a.md @./b.md @./user/c.md ");
  expect(host.querySelectorAll('[data-slot="chat-composer-asset"]').length).toBe(3);
  expect(submitted).toBe(false);
});

// 引用语义逐项保留明确选择，不能误用删除的父子路径折叠规则。
test("同时选择文件夹与子文件时两项均可引用", async () => {
  await render();
  select("docs");
  select("docs/note.md", true);
  reference("docs");
  expect(references).toEqual([
    { path: "docs", name: "docs" },
    { path: "docs/note.md", name: "note.md" },
  ]);
});
