import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { FileTreeArborist } from "../components/file-tree-arborist";
import { FileTreeContextMenu } from "../components/file-tree-context-menu";
import { parsePathsToTree, selectFileTreePaths } from "../components/file-tree-model";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { initializeHappyDomWindow } from "../testing";

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
  lng: "en",
  initAsync: false,
  resources: { en: { [UI_COMPONENTS_NS]: en } },
  defaultNS: UI_COMPONENTS_NS,
});
let root: Root;
let host: HTMLElement;
const tree = parsePathsToTree(["docs/a.md", "docs/b.md", "target/"]).filter((node) => node.path !== "user");

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
});
afterEach(() => {
  act(() => root.unmount());
  win.document.body.innerHTML = "";
});
afterAll(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 渲染真实虚拟树，用父组件状态模拟受控选择。 */
function renderTree(initial: string[] = [], initialExpanded = ["docs"]) {
  const previews: string[] = [];
  const drags: string[] = [];
  let paths = initial;
  function Harness() {
    const [selection, setSelection] = useState({ paths: initial, anchor: initial[0] ?? null });
    const [expanded, setExpanded] = useState(initialExpanded);
    paths = selection.paths;
    return (
      <FileTreeArborist
        data={tree}
        expandedIds={expanded}
        selectedPaths={selection.paths}
        onSelect={(node, gesture) => {
          setSelection((current) =>
            selectFileTreePaths(current, node.path, ["docs", "docs/a.md", "docs/b.md", "target"], gesture),
          );
          if (!gesture.toggle && !gesture.range && !node.isDir) previews.push(node.path);
        }}
        onSelectionChange={(next) => setSelection({ paths: next, anchor: next[0] ?? null })}
        onDragStart={(_event, path) => drags.push(path)}
        onDragEnd={() => {}}
        onToggle={(path, open) =>
          setExpanded((current) => (open ? [...new Set([...current, path])] : current.filter((item) => item !== path)))
        }
        onRefresh={() => {}}
        onNewFile={() => {}}
      />
    );
  }
  try {
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Harness />
        </I18nextProvider>,
      ),
    );
  } catch (error) {
    if (error instanceof AggregateError) throw error.errors[0];
    throw error;
  }
  return { previews, drags, selected: () => paths };
}
function row(path: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(`[data-node-id="${path}"]`);
  if (!node) throw new Error(`Missing row ${path}`);
  return node;
}
function click(path: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) {
  act(() => row(path).dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...modifiers })));
}

describe("虚拟文件树交互", () => {
  // 修饰键点击目录图标与点击行文字遵循相同选择规则，不能意外展开目录。
  test.each([
    { name: "Cmd", modifiers: { metaKey: true }, expected: ["docs/a.md", "target"] },
    { name: "Ctrl", modifiers: { ctrlKey: true }, expected: ["docs/a.md", "target"] },
    { name: "Shift", modifiers: { shiftKey: true }, expected: ["docs/a.md", "docs/b.md", "target"] },
  ])("$name 点击目录图标只修改选择", ({ modifiers, expected }) => {
    const calls = renderTree(["docs/a.md"]);
    act(() =>
      row("target")
        .querySelector<HTMLButtonElement>("button")
        ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...modifiers })),
    );
    expect(calls.selected()).toEqual(expected);
    expect(row("target").closest('[role="treeitem"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(calls.previews).toEqual([]);
  });

  // 普通单击保留预览习惯，多选修饰键不能打开额外预览。
  test("单击预览，Cmd/Ctrl 和 Shift 只改变选择", () => {
    const calls = renderTree();
    click("docs/a.md");
    click("docs/b.md", { metaKey: true });
    expect(calls.selected()).toEqual(["docs/a.md", "docs/b.md"]);
    expect(calls.previews).toEqual(["docs/a.md"]);
    click("target", { shiftKey: true });
    expect(calls.selected()).toEqual(["docs/b.md", "target"]);
    expect(calls.previews).toEqual(["docs/a.md"]);
  });

  // 外部刷新重建树时仍应还原整组高亮和可访问的选择状态。
  test("受控多选同步到可访问状态且不出现复选框", () => {
    renderTree(["docs/a.md", "docs/b.md"]);
    expect(row("docs/a.md").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");
    expect(row("docs/b.md").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  });

  // 原生拖动由容器统一编排，不能被第三方树的单树拖动后端拦截。
  test("文件行发出拖动起点，行内不再提供直接删除", () => {
    const calls = renderTree(["docs/a.md", "docs/b.md"]);
    expect(row("docs/a.md").getAttribute("draggable")).toBe("true");
    act(() => row("docs/a.md").dispatchEvent(new win.Event("dragstart", { bubbles: true })));
    expect(calls.drags).toEqual(["docs/a.md"]);
    expect(host.querySelector('button[title="Delete"]')).toBeNull();
  });

  // 折叠目录不取消其子文件选择，重新展开时视觉和 aria 状态必须一致。
  test("折叠后重新展开仍还原子项选择", () => {
    const calls = renderTree(["docs/a.md"]);
    act(() => row("docs").querySelector<HTMLButtonElement>("button")?.click());
    expect(calls.selected()).toEqual(["docs/a.md"]);
    act(() => row("docs").querySelector<HTMLButtonElement>("button")?.click());
    expect(row("docs/a.md").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");
  });

  // 刷新时目录可能处于折叠状态，稍后展开仍须恢复外层保留的选择。
  test("初始隐藏的选中项展开后恢复 aria 选择", () => {
    renderTree(["docs/a.md"], []);
    act(() => row("docs").querySelector<HTMLButtonElement>("button")?.click());
    expect(row("docs/a.md").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");
  });
});

describe("多选右键菜单", () => {
  // 菜单必须支持键盘进入与逐项导航，不能依赖鼠标点击危险操作。
  test("打开菜单聚焦首项，方向键切换菜单项", () => {
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <FileTreeContextMenu
            state={{ x: 10, y: 10, path: "docs/a.md", isDir: false }}
            onReference={() => {}}
            onDownload={() => {}}
            onRenameRequest={() => {}}
            onMoveRequest={() => {}}
            onDeleteRequest={() => {}}
            onNewFile={() => {}}
            onNewFolder={() => {}}
          />
        </I18nextProvider>,
      ),
    );
    const menu = win.document.querySelector('[role="menu"]');
    const items = menu?.querySelectorAll("button");
    expect(menu?.querySelectorAll('[role="menuitem"]').length).toBe(items?.length);
    expect(win.document.activeElement).toBe(items?.[0]);
    act(() => menu?.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
    expect(win.document.activeElement).toBe(items?.[1]);
  });

  // 批量选择不能误执行下载或重命名单项，删除需用户明确点击菜单项。
  test("多选菜单仅呈现整组删除且打开菜单不执行删除", () => {
    const deleted: string[] = [];
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <FileTreeContextMenu
            state={{ x: 10, y: 10, path: "docs/a.md", isDir: false, paths: ["docs/a.md", "docs/b.md"] }}
            onReference={() => {}}
            onDownload={() => {}}
            onRenameRequest={() => {}}
            onMoveRequest={() => {}}
            onDeleteRequest={(path) => deleted.push(path)}
            onNewFile={() => {}}
            onNewFolder={() => {}}
          />
        </I18nextProvider>,
      ),
    );
    const menu = win.document.querySelector('[role="menu"]');
    expect(menu?.querySelectorAll("button").length).toBe(1);
    expect(deleted).toEqual([]);
    act(() => menu?.querySelector<HTMLButtonElement>("button")?.click());
    expect(deleted).toEqual(["docs/a.md"]);
  });
});
