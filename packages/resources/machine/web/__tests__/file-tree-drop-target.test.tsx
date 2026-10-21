// 文件上传落点回归：两个分区各有新建/上传/上传文件夹入口且只操作本分区根目录；
// 树内拖拽按落点解析（分区根或目录节点），进度条归属按落点换算。
//
// 为什么必须渲染而不是扫源码：落点解析读的是 `event.target.closest(...)`，分区按钮的上传目标
// 也只能通过真实点击观察；happy-dom + react-dom/client 与同包布局切换用例同款。
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FileTreeView, type FileTreeViewProps } from "@fenix/ui-components";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance, type i18n as I18nInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { resolveUploadSection } from "../components/FileTreeTab";
import { MACHINE_NS, machineResources } from "../i18n";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

const DOM_GLOBALS = [
  "CustomEvent",
  "DOMRect",
  "Element",
  "Event",
  "HTMLElement",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "ResizeObserver",
  "customElements",
] as const;

const TRACKED_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  ...DOM_GLOBALS,
] as const;

const originalGlobals = new Map<string, unknown>(TRACKED_GLOBALS.map((key) => [key, globals[key]] as const));

function applyDomGlobals(): void {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.localStorage = win.localStorage;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of DOM_GLOBALS) {
    globals[key] = (win as unknown as Record<string, unknown>)[key];
  }
  globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
}

const i18n: I18nInstance = createInstance();
await i18n.init({
  lng: "zh",
  fallbackLng: "zh",
  initAsync: false,
  defaultNS: MACHINE_NS,
  interpolation: { escapeValue: false },
  resources: {
    zh: { [MACHINE_NS]: machineResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh },
  },
});

interface TreeCalls {
  newFolder: string[];
  upload: (string | undefined)[];
  uploadFolder: (string | undefined)[];
  drop: (string | undefined)[];
}

/** 视图契约的最小注入；上传相关回调把参数记进 `calls`，其余为空实现。 */
function treeProps(calls: TreeCalls): FileTreeViewProps {
  return {
    loading: false,
    stale: false,
    uploading: false,
    dragOver: false,
    searchQuery: "",
    normalizedSearch: "",
    hasSearchResults: false,
    treeVersion: 1,
    // 不渲染 arborist：本文件只验证分区结构与落点解析，节点行能力另有 SSR 用例覆盖。
    showTree: false,
    workspaceHasNodes: false,
    userHasNodes: false,
    expandedIds: [],
    contextMenu: null,
    deleteConfirm: null,
    deleting: false,
    download: null,
    fileInputRef: { current: null },
    folderInputRef: { current: null },
    workspaceNodes: [],
    userNodes: [],
    onSelect: () => {},
    onToggle: () => {},
    onSearchChange: () => {},
    onRefresh: () => {},
    onUploadClick: (targetDir) => calls.upload.push(targetDir),
    onFolderUploadClick: (targetDir) => calls.uploadFolder.push(targetDir),
    onDrop: (_event, targetDir) => calls.drop.push(targetDir),
    onFileInputChange: () => {},
    onFolderInputChange: () => {},
    onDragOver: () => {},
    onDragEnter: () => {},
    onDragLeave: () => {},
    onContextMenu: () => {},
    onReference: () => {},
    onDownload: () => {},
    onRenameRequest: () => {},
    onMoveRequest: () => {},
    onDeleteRequest: () => {},
    onNewFile: () => {},
    onNewFolder: (parentPath) => calls.newFolder.push(parentPath),
    onCloseDelete: () => {},
    onConfirmDelete: () => {},
  };
}

let mounted: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  applyDomGlobals();
  container = win.document.createElement("div");
  win.document.body.append(container);
  mounted = createRoot(container);
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  win.document.body.innerHTML = "";
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function renderTree(): TreeCalls {
  const calls: TreeCalls = { newFolder: [], upload: [], uploadFolder: [], drop: [] };
  act(() => {
    mounted?.render(
      <I18nextProvider i18n={i18n}>
        <FileTreeView {...treeProps(calls)} />
      </I18nextProvider>,
    );
  });
  return calls;
}

function sectionButton(section: "" | "user", slot: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`[data-upload-target="${section}"] [data-slot="${slot}"]`);
  if (!button) throw new Error(`missing ${slot} in section ${section}`);
  return button;
}

function fireDrop(target: Element): void {
  act(() => {
    target.dispatchEvent(new win.Event("drop", { bubbles: true, cancelable: true }));
  });
}

describe("分区动作入口", () => {
  // 每个分区的三个入口都只操作本分区根目录：工作区为 ""，我的文件为 "user"。
  test("两个分区各自把三个动作指向本分区根目录", () => {
    const calls = renderTree();

    act(() => sectionButton("", "file-tree-section-new-folder").click());
    act(() => sectionButton("user", "file-tree-section-new-folder").click());
    act(() => sectionButton("", "file-tree-section-upload").click());
    act(() => sectionButton("user", "file-tree-section-upload").click());
    act(() => sectionButton("", "file-tree-section-upload-folder").click());
    act(() => sectionButton("user", "file-tree-section-upload-folder").click());

    expect(calls.newFolder).toEqual(["", "user"]);
    expect(calls.upload).toEqual(["", "user"]);
    expect(calls.uploadFolder).toEqual(["", "user"]);
  });
});

describe("拖拽落点解析", () => {
  // 分区根与目录节点分别解析出各自目标；树内 drop 只触发一次 onDrop。
  test("分区根与目录节点各自得到正确落点", () => {
    const calls = renderTree();
    const sections = container.querySelector('[data-slot="file-tree-sections"]');
    if (!sections) throw new Error("missing file-tree-sections");

    fireDrop(container.querySelector('[data-upload-target=""]')!);
    fireDrop(container.querySelector('[data-upload-target="user"]')!);
    const dirNode = win.document.createElement("div");
    dirNode.setAttribute("data-node-id", "user/sub");
    dirNode.setAttribute("data-is-dir", "true");
    sections.append(dirNode);
    fireDrop(dirNode);

    expect(calls.drop).toEqual(["", "user", "user/sub"]);
  });
});

describe("上传进度分区", () => {
  // 进度条归属只由落点决定：user 作用域归「我的文件」，其余（含相似前缀）归工作区。
  test("user 作用域归我的文件，相似前缀不误判", () => {
    expect(resolveUploadSection("")).toBe("workspace");
    expect(resolveUploadSection("docs")).toBe("workspace");
    expect(resolveUploadSection("user")).toBe("user");
    expect(resolveUploadSection("user/sub")).toBe("user");
    expect(resolveUploadSection("userdata")).toBe("workspace");
    expect(resolveUploadSection("\\user\\sub\\")).toBe("user");
  });
});
