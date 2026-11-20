import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { EditorView } from "codemirror";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { isMarkdownRichTextFile } from "../editors/editor-language";
import { FileEditor } from "../editors/file-editor";
import { preserveRawFrontmatter } from "../editors/markdown-frontmatter";
import { loadOfficeScript } from "../editors/office-script";

const win = initializeHappyDomWindow(
  new Window({
    url: "https://localhost",
    settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: false },
  }),
);
const i18n = createInstance();
void i18n.init({ lng: "en", resources: {}, initAsync: false });
const restoredKeys = [
  "window",
  "document",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
  "MutationObserver",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "NodeFilter",
  "Text",
  "Element",
  "SVGElement",
  "DocumentFragment",
  "CustomEvent",
  "DOMParser",
  "Event",
  "KeyboardEvent",
  "customElements",
  "ResizeObserver",
  "getComputedStyle",
  "getSelection",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
];
const savedGlobals = new Map(restoredKeys.map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
afterAll(() => {
  const values = globalThis as Record<string, unknown>;
  for (const [key, value] of savedGlobals) {
    if (value === undefined) delete values[key];
    else values[key] = value;
  }
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    MutationObserver: win.MutationObserver,
    HTMLElement: win.HTMLElement,
    customElements: win.customElements,
    Node: win.Node,
    Text: win.Text,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}

// 初始化、外部回填均不能变成用户编辑，StrictMode 不得留下重复实例。
test("CodeMirror mounts symmetrically and only user transactions emit edits", async () => {
  const changes: string[] = [];
  const change = (value: string) => {
    changes.push(value);
  };
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <StrictMode>
          <FileEditor value="initial" language="plaintext" onChange={change} />
        </StrictMode>
      </I18nextProvider>,
    ),
  );
  await settle();
  expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
  expect(changes).toEqual([]);
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <StrictMode>
          <FileEditor value="remote" language="plaintext" onChange={change} />
        </StrictMode>
      </I18nextProvider>,
    ),
  );
  await settle();
  expect(changes).toEqual([]);
  const dom = host.querySelector(".cm-editor");
  if (!dom) throw new Error("missing editor");
  const editor = EditorView.findFromDOM(dom as HTMLElement);
  act(() => editor?.dispatch({ changes: { from: 0, to: 6, insert: "typed" } }));
  expect(changes).toEqual(["typed"]);
});

// 未编辑 YAML 必须逐字节保留注释、空白和 CRLF；MDX 始终保留源码。
test("rich markdown preserves raw frontmatter while MDX stays source", () => {
  const raw = '---\r\n# 说明\r\nname: "a"  \r\n---\r\n\r\n正文\r\n';
  const serialized = '---\n# 说明\nname: "a"  \n---\n\n新正文\n';
  expect(preserveRawFrontmatter(raw, serialized)).toBe('---\r\n# 说明\r\nname: "a"  \r\n---\r\n\n新正文\n');
  expect(isMarkdownRichTextFile("component.mdx")).toBe(false);
});

// 文档脚本并发请求复用同一加载；失败后可重新尝试而不是永久缓存 rejection。
test("Office script loader shares concurrent requests and permits retry", async () => {
  const originalAppend = document.head.appendChild;
  const scripts: HTMLScriptElement[] = [];
  document.head.appendChild = <T extends Node>(node: T): T => {
    scripts.push(node as unknown as HTMLScriptElement);
    return node;
  };
  const first = loadOfficeScript("https://docs.example.test/api.js");
  const second = loadOfficeScript("https://docs.example.test/api.js");
  expect(first).toBe(second);
  const script = scripts[0];
  script?.dispatchEvent(new win.Event("error") as unknown as Event);
  await expect(first).rejects.toThrow();
  const retry = loadOfficeScript("https://docs.example.test/api.js");
  Object.assign(window, { DocsAPI: { DocEditor: class {} } });
  scripts[1]?.dispatchEvent(new win.Event("load") as unknown as Event);
  await expect(retry).resolves.toBeDefined();
  delete (window as unknown as Record<string, unknown>).DocsAPI;
  document.head.appendChild = originalAppend;
});

// Office StrictMode 只保留一个实例，状态轮询与过期消息不能重建脏文档。
test("Office lifecycle keeps dirty iframe on errors and expiry", async () => {
  const { OfficeEditor } = await import("../editors/office-editor");
  const originalAppend = document.head.appendChild;
  const scripts: HTMLScriptElement[] = [];
  document.head.appendChild = <T extends Node>(node: T): T => {
    scripts.push(node as unknown as HTMLScriptElement);
    return node;
  };
  let created = 0;
  let destroyed = 0;
  let events: Record<string, (event: { data: boolean }) => void> = {};
  Object.assign(window, {
    DocsAPI: {
      DocEditor: class {
        constructor(_id: string, config: { events: typeof events }) {
          created++;
          events = config.events;
        }
        destroyEditor() {
          destroyed++;
        }
      },
    },
  });
  const session = {
    id: "s1",
    state: "editing" as const,
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: 10000,
    maxBytes: 96468992,
    initialization: { scriptUrl: "https://docs.example.test/lifecycle.js", config: {} },
  };
  const render = (expired = false) => (
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <OfficeEditor
          session={{ ...session, state: expired ? "expired" : "editing" }}
          onDirty={() => {}}
          onError={() => {}}
          onSave={() => {}}
        />
      </StrictMode>
    </I18nextProvider>
  );
  act(() => root.render(render()));
  scripts[0]?.dispatchEvent(new win.Event("load") as unknown as Event);
  await settle();
  expect(created).toBe(1);
  act(() => {
    events.onDocumentStateChange?.({ data: true });
    events.onError?.({ data: true });
  });
  expect(host.querySelector("button")).toBeNull();
  act(() => root.render(render(true)));
  expect(created).toBe(1);
  expect(destroyed).toBe(0);
  act(() => root.unmount());
  expect(destroyed).toBe(1);
  root = createRoot(host);
  document.head.appendChild = originalAppend;
  delete (window as unknown as Record<string, unknown>).DocsAPI;
});

// 富文本初始化的规范化事务不能产生脏标记；外部回填需对称重建。
test("Markdown initialization and external reload do not emit edits", async () => {
  const globals = globalThis as Record<string, unknown>;
  const browser = win as unknown as Record<string, unknown>;
  for (const key of [
    "SVGElement",
    "CustomEvent",
    "DOMParser",
    "Element",
    "Event",
    "HTMLElement",
    "MutationObserver",
    "Node",
    "Text",
    "customElements",
    "ResizeObserver",
  ])
    globals[key] = browser[key];
  for (const key of [
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
    "getComputedStyle",
    "getSelection",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]) {
    const value = browser[key];
    if (typeof value === "function") globals[key] = value.bind(win);
  }
  const { MarkdownEditor } = await import("../editors/markdown-editor");
  const changes: string[] = [];
  const change = (value: string) => {
    changes.push(value);
  };
  const render = (value: string) => (
    <I18nextProvider i18n={i18n}>
      <StrictMode>
        <MarkdownEditor value={value} onChange={change} />
      </StrictMode>
    </I18nextProvider>
  );
  act(() => root.render(render('---\nname: "demo"\n---\n\n# Initial\n')));
  for (let index = 0; index < 10 && !host.querySelector(".ProseMirror"); index++) await settle();
  expect(host.querySelectorAll(".ProseMirror")).toHaveLength(1);
  expect(changes).toEqual([]);
  act(() => root.render(render("# Reloaded\n")));
  await settle();
  await settle();
  expect(host.querySelectorAll(".ProseMirror")).toHaveLength(1);
  expect(host.textContent).toContain("Reloaded");
  expect(changes).toEqual([]);
});

// 文档就绪和 cache false 回执共同解除同步屏障，但不会发送工作区清脏事件。
test("Office preparation waits for actual provider synchronization events", async () => {
  const { OfficeEditor } = await import("../editors/office-editor");
  const originalAppend = document.head.appendChild;
  const scripts: HTMLScriptElement[] = [];
  document.head.appendChild = <T extends Node>(node: T): T => {
    scripts.push(node as unknown as HTMLScriptElement);
    return node;
  };
  let events: Record<string, (event?: { data: boolean }) => void> = {};
  let prepare!: (signal: AbortSignal) => Promise<boolean>;
  let unregisters = 0;
  const dirty: boolean[] = [];
  Object.assign(window, {
    DocsAPI: {
      DocEditor: class {
        constructor(_id: string, config: { events: typeof events }) {
          events = config.events;
        }
        destroyEditor() {}
      },
    },
  });
  const session = {
    id: "barrier",
    state: "editing" as const,
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: 10000,
    maxBytes: 96468992,
    initialization: { scriptUrl: "https://docs.example.test/barrier.js", config: {} },
  };
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <OfficeEditor
          session={session}
          onDirty={(value) => dirty.push(value)}
          onError={() => {}}
          onSave={() => {}}
          onPrepareSave={(callback) => {
            prepare = callback;
            return () => {
              unregisters++;
            };
          }}
        />
      </I18nextProvider>,
    ),
  );
  scripts[0]?.dispatchEvent(new win.Event("load") as unknown as Event);
  await settle();
  const signal = new AbortController();
  let synchronized = false;
  const initiallyReady = prepare(signal.signal).then((value) => {
    synchronized = value;
  });
  await settle();
  expect(synchronized).toBe(false);
  act(() => events.onDocumentReady?.());
  await initiallyReady;
  expect(synchronized).toBe(true);
  act(() => events.onDocumentStateChange?.({ data: true }));
  synchronized = false;
  const afterEdits = prepare(signal.signal).then((value) => {
    synchronized = value;
  });
  await settle();
  expect(synchronized).toBe(false);
  act(() => events.onDocumentStateChange?.({ data: false }));
  await afterEdits;
  expect(synchronized).toBe(true);
  expect(dirty).toEqual([true, false]);
  act(() => events.onDocumentStateChange?.({ data: true }));
  const abort = new AbortController();
  const waiting = prepare(abort.signal);
  abort.abort(new Error("cancelled"));
  await expect(waiting).rejects.toThrow("cancelled");
  act(() => root.unmount());
  root = createRoot(host);
  expect(unregisters).toBe(1);
  await expect(prepare(new AbortController().signal)).rejects.toMatchObject({ code: "unavailable" });
  document.head.appendChild = originalAppend;
  delete (window as unknown as Record<string, unknown>).DocsAPI;
});
