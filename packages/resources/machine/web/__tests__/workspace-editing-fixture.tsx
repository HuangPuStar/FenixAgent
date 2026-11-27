import { afterAll, afterEach, beforeEach } from "bun:test";
import type { EditingClient } from "@fenix/file-editing/contracts";
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
let workspaceWidth = 800;
const originalOffsetWidth = Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, "offsetWidth")?.get;
const originalOffsetLeft = Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, "offsetLeft")?.get;
Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    const panelSelector = '[data-slot="resizable-panel"]';
    if (!this.matches(panelSelector)) return originalOffsetWidth?.call(this) ?? 0;

    // happy-dom 不做布局。初始测量按像素分配，之后按面板库计算的比例分配。
    const basis = Number.parseFloat(this.style.flexBasis);
    if (basis > 0) return basis;
    const panels = this.parentElement?.querySelectorAll<HTMLElement>(panelSelector) ?? [];
    const other = [...panels].find((panel) => panel !== this);
    const otherBasis = Number.parseFloat(other?.style.flexBasis ?? "");
    if (otherBasis > 0) return workspaceWidth - otherBasis;
    return (Number(this.style.flexGrow) / 100) * workspaceWidth;
  },
});
Object.defineProperty(win.HTMLElement.prototype, "offsetLeft", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.parentElement?.dataset.slot !== "resizable-panel-group") return originalOffsetLeft?.call(this) ?? 0;
    // 面板库按横向坐标识别分隔条两侧的面板。
    let offset = 0;
    for (
      let sibling = this.previousElementSibling;
      sibling instanceof HTMLElement;
      sibling = sibling.previousElementSibling
    ) {
      offset += sibling.offsetWidth;
    }
    return offset;
  },
});
// 面板库通过 ARIA 属性判断分隔条是否可用，happy-dom 缺少该属性反射。
Object.defineProperty(win.HTMLElement.prototype, "ariaDisabled", {
  configurable: true,
  get(this: HTMLElement) {
    return this.getAttribute("aria-disabled");
  },
});
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
const fileSizes: Record<string, number> = {};
let treeDelay: Promise<void> | undefined;
let current: { files: string[]; active: string | null };
/** Build a versioned file response for the editing transport fixture. */
const snapshot = (path: string) => ({
  path,
  name: path,
  content: "original",
  size: 8,
  version: "v1",
  encoding: "utf8",
});
/** Control when an external transport request resolves. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Render the workspace with host callbacks that preserve the selected files. */
function render(
  files: string[],
  active: string | null,
  onQuoteSelection?: Parameters<typeof Workspace>[0]["onQuoteSelection"],
) {
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
          onQuoteSelection={onQuoteSelection}
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
/** Flush asynchronous file requests and React effects. */
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}
/** Wait for the lazily loaded text editor to mount. */
async function ready() {
  for (let index = 0; index < 10 && !host.querySelector(".cm-editor"); index++) await settle();
}
/** Enter editing through the visible workspace action. */
async function startEditing() {
  await settle();
  act(() => button("Edit").click());
  await ready();
}
/** Change the real CodeMirror document to exercise draft behavior. */
function edit(content: string) {
  const dom = host.querySelector(".cm-editor");
  if (!dom) throw new Error("editor missing");
  const view = EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error("view missing");
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } }));
}
/** Find an action by its visible or accessible label. */
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
  workspaceWidth = 800;
  treeDelay = undefined;
  const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/fs/tree")) {
      await treeDelay;
      return new Response(
        JSON.stringify({ success: true, data: { paths: Object.keys(fileSizes), mtimes: {}, sizes: fileSizes } }),
        { headers: { "content-type": "application/json" } },
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
  for (const path of Object.keys(fileSizes)) delete fileSizes[path];
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

/** Switch the environment while keeping the same mounted workspace. */
function setEnvironment(value: string) {
  environment = value;
}

/** Delay tree responses to verify environment changes discard stale file metadata. */
function setTreeDelay(value: Promise<void>) {
  treeDelay = value;
}

/** Simulate the width remaining after the host resizes the workspace. */
function setWorkspaceWidth(width: number) {
  workspaceWidth = width;
}

export {
  button,
  client,
  closed,
  current,
  deferred,
  edit,
  fileSizes,
  host,
  i18n,
  leave,
  ready,
  render,
  root,
  setEnvironment,
  setTreeDelay,
  settle,
  setWorkspaceWidth,
  snapshot,
  startEditing,
  Workspace,
  writes,
};
