import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { type EditingClient, EditingError } from "@fenix/file-editing/contracts";
import { FILE_EDITING_NS, fileEditingResources } from "@fenix/file-editing/web/i18n";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { EditorView } from "codemirror";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { MACHINE_NS, machineResources } from "../i18n";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost" }));
const globals = globalThis as Record<string, unknown>;
const tracked = [
  "window",
  "history",
  "location",
  "scrollTo",
  "document",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
  "MutationObserver",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "NodeFilter",
  "Text",
  "Element",
  "DocumentFragment",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "ResizeObserver",
  "DOMRect",
  "customElements",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "WebSocket",
  "IntersectionObserver",
];
const originalGlobals = new Map(tracked.map((key) => [key, globals[key]]));
const originalFetch = globalThis.fetch;
const i18n = createInstance();
await i18n.init({
  lng: "en",
  initAsync: false,
  resources: {
    en: {
      [MACHINE_NS]: machineResources.en,
      [FILE_EDITING_NS]: fileEditingResources.en,
      [UI_COMPONENTS_NS]: uiComponentsResources.en,
    },
  },
});
let Workspace: typeof import("../components/artifacts-files-workspace").ArtifactsFilesWorkspace;
let root: Root;
let host: HTMLElement;
let client: EditingClient;
let closed: string[];
let writes: { path: string; content: string }[];
let leave: (() => Promise<boolean>) | null;
let environment = "env-1";
let current: { files: string[]; active: string | null };
let treeSizes: Record<string, number>;
let treeDelay: Promise<void> | undefined;
const snapshot = (path: string) => ({
  path,
  name: path,
  content: "original",
  size: 8,
  version: "v1",
  encoding: "utf8",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function render(files: string[], active: string | null) {
  current = { files, active };
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Workspace
          envId={environment}
          openFiles={files}
          activeFile={active}
          changedFiles={[]}
          editingClient={client}
          onRegisterBeforeLeave={(guard) => {
            leave = guard;
          }}
          onSelectFile={(path) => render(current.files, path)}
          onCloseFile={(path) => {
            closed.push(path);
            render(
              current.files.filter((file) => file !== path),
              current.active === path ? null : current.active,
            );
          }}
          onOpenFile={(path) => render([...new Set([path, ...current.files])], path)}
          onReferenceFile={() => {}}
          onFilesChanged={() => {}}
        />
      </I18nextProvider>,
    ),
  );
}
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}
async function ready() {
  for (let index = 0; index < 10 && !host.querySelector(".cm-editor"); index++) await settle();
}
async function startEditing() {
  await settle();
  act(() => button("Edit").click());
  await ready();
}
function edit(content: string) {
  const dom = host.querySelector(".cm-editor");
  if (!dom) throw new Error("editor missing");
  const view = EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error("view missing");
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } }));
}
function button(label: string, parent: ParentNode = document.body) {
  const element = [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}
beforeEach(async () => {
  const browser = win as unknown as Record<string, unknown>;
  for (const key of tracked) globals[key] = browser[key];
  Object.assign(globals, {
    window: win,
    history: win.history,
    location: win.location,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "scrollTo"]) {
    const value = browser[key];
    if (typeof value === "function") globals[key] = value.bind(win);
  }
  class ViewportObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globals.IntersectionObserver = ViewportObserver;
  (win as unknown as Record<string, unknown>).IntersectionObserver = ViewportObserver;
  globals.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    close() {}
    send() {}
  };
  win.localStorage.clear();
  treeSizes = {};
  treeDelay = undefined;
  const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/fs/tree")) {
      await treeDelay;
      return new Response(
        JSON.stringify({ success: true, data: { paths: Object.keys(treeSizes), mtimes: {}, sizes: treeSizes } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }
    return String(input).includes(".txt")
      ? new Response("Read-only preview", { headers: { "content-type": "text/plain" } })
      : new Response("Preview unavailable", { status: 404 });
  };
  globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
  ({ ArtifactsFilesWorkspace: Workspace } = await import("../components/artifacts-files-workspace"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  closed = [];
  writes = [];
  leave = null;
  environment = "env-1";
  const unavailable = async (): Promise<never> => {
    throw new Error("Office unavailable");
  };
  client = {
    capabilities: async () => ({
      text: { enabled: true },
      textMaxBytes: 2097152,
      office: { enabled: false, extensions: ["docx"], maxBytes: 96468992 },
    }),
    readText: async ({ path }) => snapshot(path),
    saveText: async ({ path }, content) => {
      writes.push({ path, content });
      return { path, size: content.length, version: "v2" };
    },
    openOffice: unavailable,
    saveOffice: unavailable,
    getSession: unavailable,
    overwriteOffice: unavailable,
    closeOffice: unavailable,
    discardOffice: unavailable,
  };
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await win.happyDOM.abort();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

// 旧沙盒和未声明文本能力的服务只提供预览，不能进入必然失败的版本化读取。
test.each([false, undefined])("unsupported text capability %s keeps preview without editing", async (enabled) => {
  client.capabilities = async () => ({
    ...(enabled === undefined ? {} : { text: { enabled } }),
    textMaxBytes: 2097152,
    office: { enabled: false, extensions: [], maxBytes: 96468992 },
  });
  client.readText = async () => {
    throw new Error("Unsupported runtime must stay in preview");
  };
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]'))).toBe(false);
  expect(host.querySelector('a[aria-label="Download"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

// 能力未确认时不得抢先开放文本入口，确认支持后继续原来的编辑保存。
test("text editing waits for confirmed runtime capabilities", async () => {
  const pending = deferred<Awaited<ReturnType<EditingClient["capabilities"]>>>();
  client.capabilities = () => pending.promise;
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(false);
  pending.resolve({
    text: { enabled: true },
    textMaxBytes: 2097152,
    office: { enabled: false, extensions: [], maxBytes: 96468992 },
  });
  await startEditing();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
});

// 文件树已有尺寸超过文本限制时，应保留预览而不重复读取超大文件来尝试编辑。
test.each([2097152, 2097153, 96468992])("known text size %s determines preview edit availability", async (size) => {
  treeSizes = { "large.txt": size };
  render(["large.txt"], "large.txt");
  await settle();
  const edit = host.querySelector('button[aria-label="Edit"]:not(:disabled)');
  expect(Boolean(edit)).toBe(size <= 2097152);
  expect(host.querySelector('a[aria-label="Download"]')).not.toBeNull();
});

// 刷新取得新尺寸后立即重算入口；缺少单个文件的尺寸时仍保留加载阶段的大小保护。
test("tree refresh recomputes text editing availability without an extra file read", async () => {
  treeSizes = { "large.txt": 96468992 };
  render(["large.txt"], "large.txt");
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]'))).toBe(false);
  treeSizes = { "large.txt": 8 };
  act(() => button("Refresh", host).click());
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(true);
});

// 迟到的尺寸更新只影响新的编辑入口，不能销毁已经输入的草稿。
test("an oversized tree update cannot destroy an existing text draft", async () => {
  treeSizes = { "note.txt": 8 };
  render(["note.txt"], "note.txt");
  await startEditing();
  edit("unsaved draft");
  treeSizes = { "note.txt": 96468992 };
  act(() => button("Refresh", host).click());
  await settle();
  expect(host.querySelector(".cm-content")?.textContent).toBe("unsaved draft");
  expect(writes).toHaveLength(0);
});

// 文本能力请求临时失败时应提供当前文件可操作的重试入口。
test("text capability failure can retry in the current preview", async () => {
  let fail = true;
  client.capabilities = async () => {
    if (fail) throw new Error("Capabilities temporarily unavailable");
    return {
      text: { enabled: true },
      textMaxBytes: 2097152,
      office: { enabled: false, extensions: [], maxBytes: 96468992 },
    };
  };
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('[role="alert"]'))).toBe(true);
  fail = false;
  act(() => button("Retry", host).click());
  await startEditing();
  expect(Boolean(host.querySelector(".cm-editor"))).toBe(true);
});

// A→B→A期间没有取得新树时，旧的尺寸不能重新开放可能已经增长的文件。
test("returning to an environment waits for a fresh size snapshot", async () => {
  treeSizes = { "note.txt": 8 };
  render(["note.txt"], "note.txt");
  await settle();
  const pending = deferred<void>();
  treeDelay = pending.promise;
  environment = "env-2";
  render(["note.txt"], "note.txt");
  await settle();
  environment = "env-1";
  render(["note.txt"], "note.txt");
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(false);
  treeSizes = { "note.txt": 96468992 };
  pending.resolve();
  await settle();
  expect(Boolean(host.querySelector('button[aria-label="Edit"]'))).toBe(false);
});

// 干净文件增长超限后真正返回预览，后续缩小也不应未经操作自动进入编辑。
test("a clean text editor returns to preview when its file grows beyond the limit", async () => {
  let grown = false;
  client.readText = async ({ path }) => {
    if (grown) throw new EditingError("too-large", "textTooLarge");
    return snapshot(path);
  };
  treeSizes = { "note.txt": 8 };
  render(["note.txt"], "note.txt");
  await startEditing();
  grown = true;
  treeSizes = { "note.txt": 96468992 };
  act(() => button("Refresh", host).click());
  await settle();
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Retry")).toBe(false);
  grown = false;
  treeSizes = { "note.txt": 8 };
  act(() => button("Refresh", host).click());
  await settle();
  expect(Boolean(host.querySelector(".cm-editor"))).toBe(false);
  expect(Boolean(host.querySelector('button[aria-label="Edit"]:not(:disabled)'))).toBe(true);
});

// 手动刷新应读取 Agent 的最新内容，但不能静默覆盖本地尚未保存的草稿。
test("manual refresh updates a clean file and preserves dirty edits on external changes", async () => {
  let disk = "original";
  client.readText = async ({ path }) => ({ ...snapshot(path), content: disk, version: disk });
  render(["note.txt"], "note.txt");
  await startEditing();
  disk = "agent update";
  act(() => button("Refresh").click());
  await settle();
  expect(host.querySelector(".cm-content")?.textContent).toBe("agent update");
  edit("local draft");
  disk = "second agent update";
  act(() => button("Refresh").click());
  await settle();
  expect(host.querySelector(".cm-content")?.textContent).toBe("local draft");
  expect(host.textContent).toContain("This file changed externally");
  expect(writes).toEqual([]);
});

// HTML 默认使用原渲染预览，只有用户明确选择编辑才读取可编辑文本。
test("HTML opens in its rendered preview and starts editing only on request", async () => {
  let reads = 0;
  client.readText = async ({ path }) => {
    reads++;
    return snapshot(path);
  };
  render(["page.html"], "page.html");
  for (let index = 0; index < 10 && !host.querySelector('iframe[title="page.html"]'); index++) await settle();
  expect(host.querySelector('iframe[title="page.html"]')).not.toBeNull();
  expect(host.querySelector(".cm-editor")).toBeNull();
  expect(reads).toBe(0);
  act(() => button("Edit").click());
  await ready();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
  expect(reads).toBe(1);
});

// 两种模式下载同一份已保存文件，下载入口不能隐式提交当前草稿。
test("preview and editor download the same workspace file without saving a draft", async () => {
  render(["draft.txt"], "draft.txt");
  await settle();
  const download = () => host.querySelector<HTMLAnchorElement>('a[aria-label="Download"]');
  expect(download()?.getAttribute("href")).toBe("/web/environments/env-1/fs/draft.txt?preview=true");
  await startEditing();
  edit("unsaved draft");
  expect(download()?.getAttribute("href")).toBe("/web/environments/env-1/fs/draft.txt?preview=true");
  expect(download()?.download).toBe("draft.txt");
  expect(writes).toEqual([]);
});

// 预览与编辑只是同一文件的视图切换，双向切换都不能撤销用户已选择的全屏状态。
test("switching between preview and editing retains fullscreen until explicitly exited", async () => {
  render(["draft.txt"], "draft.txt");
  await settle();
  act(() => button("Fullscreen").click());
  await startEditing();
  expect(Boolean(host.querySelector('section[data-page-fullscreen="true"]'))).toBe(true);
  act(() => button("Return to preview").click());
  await settle();
  expect(Boolean(host.querySelector('section[data-page-fullscreen="true"]'))).toBe(true);
  act(() => button("Exit fullscreen").click());
  expect(Boolean(host.querySelector('section[data-page-fullscreen="true"]'))).toBe(false);
});

// 父级八标签 LRU 移除脏文件后，工作台必须保留可访问的标签及原草稿。
test("dirty tabs survive parent LRU eviction and can still save", async () => {
  render(["draft.txt"], "draft.txt");
  await startEditing();
  edit("retained draft");
  render([], null);
  await settle();
  expect(host.querySelector('[title="draft.txt"]')).not.toBeNull();
  render([], "draft.txt");
  await ready();
  expect(host.querySelector(".cm-content")?.textContent).toBe("retained draft");
  act(() => button("Save").click());
  await settle();
  expect(writes).toEqual([{ path: "draft.txt", content: "retained draft" }]);
  expect(current.files).toContain("draft.txt");
});

// 标签关闭必须等待保存裁决，父级关闭回调与其他离开操作不能绕过它。
test("tab close and registered leave callback share the draft decision", async () => {
  render(["draft.txt"], "draft.txt");
  await startEditing();
  edit("draft");
  const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close tab"]');
  if (!close) throw new Error("close button missing");
  act(() => close.click());
  await settle();
  expect(closed).toEqual([]);
  expect(host.querySelector(".cm-content")?.textContent).toBe("draft");
  if (!leave) throw new Error("leave guard missing");
  let allowed!: boolean;
  await act(async () => {
    allowed = await leave!();
  });
  expect(allowed).toBe(false);
});

// 文本服务明确拒绝编辑时，保留原有只读预览并允许重试编辑。
test("unsupported text falls back to preview and editor retry works", async () => {
  client.readText = async () => {
    throw new EditingError("too-large", "Text is too large");
  };
  render(["large.txt"], "large.txt");
  await settle();
  act(() => button("Edit").click());
  await settle();
  expect(host.querySelector(".cm-editor")).toBeNull();
  expect(host.textContent).toContain("Text is too large");
  client.readText = async ({ path }) => snapshot(path);
  act(() => button("Retry", host).click());
  await ready();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
});

// 切环境后迟到的可用能力不得开启新环境不支持的 Office 编辑器。
test.each(["file.docx", "note.txt"])("stale capability results cannot enable editing %s", async (path) => {
  const old = deferred<Awaited<ReturnType<EditingClient["capabilities"]>>>();
  let opens = 0;
  client.capabilities = async (id) =>
    id === "env-1"
      ? old.promise
      : {
          text: { enabled: false },
          textMaxBytes: 2097152,
          office: { enabled: false, extensions: ["docx"], maxBytes: 96468992 },
        };
  client.openOffice = async () => {
    opens++;
    throw new Error("unexpected Office open");
  };
  render([path], path);
  environment = "env-2";
  render([path], path);
  await settle();
  old.resolve({
    text: { enabled: true },
    textMaxBytes: 2097152,
    office: { enabled: true, extensions: ["docx"], maxBytes: 96468992 },
  });
  await settle();
  expect(opens).toBe(0);
  expect([...host.querySelectorAll("button")].some((item) => item.textContent === "Edit")).toBe(false);
});

// Office 文档切到其他标签后保留同一 iframe，标签 LRU 淘汰也不能销毁它。
test("Office iframe survives tab switches and parent LRU eviction", async () => {
  const originalAppend = document.head.appendChild;
  const scripts: HTMLScriptElement[] = [];
  document.head.appendChild = <T extends Node>(node: T): T => {
    scripts.push(node as unknown as HTMLScriptElement);
    return node;
  };
  let creates = 0;
  let destroys = 0;
  let markDirty = () => {};
  const browser = window as unknown as Record<string, unknown>;
  browser.DocsAPI = {
    DocEditor: class {
      constructor(id: string, config: { events: { onDocumentStateChange(event: { data: boolean }): void } }) {
        markDirty = () => config.events.onDocumentStateChange({ data: true });
        creates++;
        const frame = document.createElement("iframe");
        frame.title = "test Office";
        document.getElementById(id)?.appendChild(frame);
      }
      destroyEditor() {
        destroys++;
      }
    },
  };
  client.capabilities = async () => ({
    text: { enabled: true },
    textMaxBytes: 2097152,
    office: { enabled: true, extensions: ["docx"], maxBytes: 96468992 },
  });
  client.openOffice = async () => ({
    id: "office-test",
    state: "editing",
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/workspace.js", config: {} },
    maxBytes: 96468992,
  });
  render(["file.docx"], "file.docx");
  await settle();
  act(() => button("Edit").click());
  await settle();
  scripts[0]?.dispatchEvent(new Event("load"));
  await settle();
  const frame = host.querySelector('iframe[title="test Office"]');
  expect(frame).not.toBeNull();
  act(() => markDirty());
  render(["note.txt"], "note.txt");
  await startEditing();
  expect(host.querySelector('iframe[title="test Office"]')).toBe(frame);
  render([], "file.docx");
  await settle();
  expect(host.querySelector('iframe[title="test Office"]')).toBe(frame);
  expect(creates).toBe(1);
  expect(destroys).toBe(0);
  document.head.appendChild = originalAppend;
  delete browser.DocsAPI;
});

// 返回预览前的取消保留草稿，保存确认完成后才切回原有预览器。
test("returning to preview cancels safely or saves before leaving the editor", async () => {
  render(["draft.txt"], "draft.txt");
  await startEditing();
  edit("preview after save");
  act(() => button("Return to preview").click());
  await settle();
  const first = document.querySelector('[role="alertdialog"][data-state="open"]');
  if (!first) throw new Error("Missing preview leave guard");
  act(() => button("Cancel", first).click());
  expect(host.querySelector(".cm-content")?.textContent).toBe("preview after save");
  act(() => button("Return to preview").click());
  await settle();
  const second = document.querySelector('[role="alertdialog"][data-state="open"]');
  if (!second) throw new Error("Missing preview save guard");
  act(() => button("Save", second).click());
  await settle();
  expect(writes).toEqual([{ path: "draft.txt", content: "preview after save" }]);
  expect(host.querySelector(".cm-editor")).toBeNull();
  expect(button("Edit")).not.toBeNull();
});

// 实际路由跳转必须等待未保存修改裁决，不能只在标签关闭时保护草稿。
test("router navigation waits for dirty workspace guard", async () => {
  const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import(
    "@tanstack/react-router"
  );
  const route = createRootRoute();
  const home = createRoute({
    getParentRoute: () => route,
    path: "/",
    component: () => (
      <Workspace
        envId="env-1"
        openFiles={["draft.txt"]}
        activeFile="draft.txt"
        changedFiles={[]}
        editingClient={client}
        onSelectFile={() => {}}
        onCloseFile={() => {}}
        onOpenFile={() => {}}
        onReferenceFile={() => {}}
        onFilesChanged={() => {}}
      />
    ),
  });
  const next = createRoute({ getParentRoute: () => route, path: "/next", component: () => <p>Next route</p> });
  const router = createRouter({
    routeTree: route.addChildren([home, next]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    ),
  );
  await startEditing();
  edit("route draft");
  act(() => {
    void router.navigate({ to: "/next" });
  });
  await settle();
  expect(router.state.location.pathname).toBe("/");
  expect(host.querySelector(".cm-content")?.textContent).toBe("route draft");
});
