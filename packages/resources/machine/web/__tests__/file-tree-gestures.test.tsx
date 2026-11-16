import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parsePathsToTree } from "@fenix/ui-components/components/file-tree-model";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, type DragEvent, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FILE_TREE_DRAG_MIME, useFileTreeInteractions } from "../hooks/use-file-tree-interactions";

const win = initializeHappyDomWindow(new Window({ url: "http://localhost" }));
const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "customElements",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = new Map(keys.map((key) => [key, globals[key]]));
const tree = parsePathsToTree(["docs/a.md", "docs/b.md", "target/", "user/z.md"]);
let root: Root;
let interactions: ReturnType<typeof useFileTreeInteractions>;
let moves: Array<{ paths: string[]; target: string }>;
let uploads: string[];
let previews: string[];
function Harness({ envId = "env-a", searchQuery = "" }: { envId?: string; searchQuery?: string }) {
  interactions = useFileTreeInteractions({
    envId,
    searchQuery,
    treeVersion: 1,
    getTree: () => tree,
    visiblePaths: ["docs", "docs/a.md", "docs/b.md", "target", "user/z.md"],
    enabled: true,
    onPreviewFile: (path) => previews.push(path),
    moveToDirectory: async (paths, target) => {
      moves.push({ paths, target });
      return true;
    },
    uploadDroppedFiles: async (_transfer, target) => {
      uploads.push(target);
    },
  });
  return null;
}
function render(props: { envId?: string; searchQuery?: string } = {}) {
  act(() => root.render(<Harness {...props} />));
}
beforeEach(() => {
  for (const key of keys)
    globals[key] = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (win as unknown as Record<string, unknown>)[key];
  globals.window = win;
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = createRoot(host);
  moves = [];
  uploads = [];
  previews = [];
  render();
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

/** 构造浏览器保护模式下可读类型、drop 时可读内容的数据传递对象。 */
function transfer(types: string[] = []) {
  const values = new Map<string, string>();
  return {
    types,
    files: [],
    effectAllowed: "uninitialized",
    dropEffect: "none",
    setData: (type: string, value: string) => {
      values.set(type, value);
      if (!types.includes(type)) types.push(type);
    },
    getData: (type: string) => values.get(type) ?? "",
  };
}
function event(data: ReturnType<typeof transfer>, path: string | null, directory = true): DragEvent<HTMLDivElement> {
  const target = win.document.createElement("div");
  if (path === null) target.dataset.uploadTarget = "user";
  else {
    target.dataset.nodeId = path;
    target.dataset.isDir = String(directory);
    target.setAttribute("data-tree-item", "");
  }
  return {
    dataTransfer: data,
    target,
    currentTarget: target,
    relatedTarget: null,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as DragEvent<HTMLDivElement>;
}
function context(path: string): MouseEvent<HTMLDivElement> {
  return { ...event(transfer(), path), clientX: 10, clientY: 10 } as unknown as MouseEvent<HTMLDivElement>;
}

describe("文件选择与菜单快照", () => {
  // 键盘菜单事件落在虚拟树外层行上，也应作用于当前文件而不是被当作空白。
  test("键盘打开当前树行菜单时保留整组选择", () => {
    const row = win.document.createElement("div");
    row.setAttribute("role", "treeitem");
    const item = win.document.createElement("div");
    item.setAttribute("data-tree-item", "");
    item.dataset.nodeId = "docs/a.md";
    row.append(item);
    win.document.body.append(row);
    act(() => interactions.setSelectedPaths(["docs/a.md", "docs/b.md"]));
    act(() =>
      interactions.handleContextMenu({
        ...context("docs/a.md"),
        target: row,
        clientX: 0,
        clientY: 0,
      } as unknown as MouseEvent<HTMLDivElement>),
    );
    expect(interactions.contextMenu?.path).toBe("docs/a.md");
    expect(interactions.contextMenu?.paths).toEqual(["docs/a.md", "docs/b.md"]);
    expect(previews).toEqual([]);
  });

  // 右键已选项保留整组，右键未选项替换选择，两个动作都不能切换预览或直接删除。
  test("右键只准备菜单，并按常规规则保留或替换选择", () => {
    act(() => interactions.setSelectedPaths(["docs/a.md", "docs/b.md"]));
    act(() => interactions.handleContextMenu(context("docs/a.md")));
    expect(interactions.contextMenu?.paths).toEqual(["docs/a.md", "docs/b.md"]);
    act(() => interactions.handleContextMenu(context("user/z.md")));
    expect(interactions.contextMenu?.paths).toEqual(["user/z.md"]);
    expect(interactions.selectedPaths).toEqual(["user/z.md"]);
    expect(previews).toEqual([]);
    expect(moves).toEqual([]);
  });

  // 搜索和环境切换都不能保留不可见的危险操作范围。
  test("搜索或环境变化清空选择和菜单", () => {
    act(() => interactions.setSelectedPaths(["docs/a.md"]));
    act(() => interactions.handleContextMenu(context("docs/a.md")));
    render({ searchQuery: "z" });
    expect(interactions.selectedPaths).toEqual([]);
    expect(interactions.contextMenu).toBeNull();
    act(() => interactions.setSelectedPaths(["user/z.md"]));
    render({ envId: "env-b", searchQuery: "z" });
    expect(interactions.selectedPaths).toEqual([]);
  });
});

describe("内部移动与外部上传", () => {
  // 拖动已选项目保留整组，放到另一分区根目录仍走移动而非上传。
  test("整组跨分区移动并高亮目标", () => {
    const data = transfer();
    act(() => interactions.setSelectedPaths(["docs/a.md", "docs/b.md"]));
    act(() => interactions.handleDragStart(event(data, "docs/a.md", false), "docs/a.md"));
    expect(data.types).toContain(FILE_TREE_DRAG_MIME);
    act(() => interactions.handleDragOver(event(data, null)));
    expect(interactions.dropTarget).toBe("user");
    expect(interactions.dragOver).toBe(false);
    act(() => interactions.handleDrop(event(data, null), "user"));
    expect(moves).toEqual([{ paths: ["docs/a.md", "docs/b.md"], target: "user" }]);
    expect(uploads).toEqual([]);
  });

  // 文件行不是目标目录，目录自身及后代也不能成为移动落点。
  test("非法落点与伪造拖动载荷均不执行写操作", () => {
    const data = transfer();
    act(() => interactions.handleDragStart(event(data, "docs"), "docs"));
    act(() => interactions.handleDragOver(event(data, "docs")));
    expect(data.dropEffect).toBe("none");
    act(() => interactions.handleDrop(event(data, "docs"), "docs"));
    expect(moves).toEqual([]);
    act(() => interactions.handleDragStart(event(data, "docs/a.md", false), "docs/a.md"));
    act(() => interactions.handleDragOver(event(data, "docs/b.md", false)));
    expect(interactions.dropTarget).toBeNull();
    data.setData(FILE_TREE_DRAG_MIME, "forged");
    act(() => interactions.handleDrop(event(data, "target"), "target"));
    expect(moves).toEqual([]);
    expect(uploads).toEqual([]);
  });

  // 浏览器本地文件继续调用上传，不读取内部移动载荷。
  test("外部文件拖入保持原有上传流程", () => {
    const data = transfer(["Files"]);
    act(() => interactions.handleDragEnter(event(data, null)));
    expect(interactions.dragOver).toBe(true);
    act(() => interactions.handleDrop(event(data, null), "user"));
    expect(uploads).toEqual(["user"]);
    expect(moves).toEqual([]);
    expect(interactions.dragOver).toBe(false);
  });
});
