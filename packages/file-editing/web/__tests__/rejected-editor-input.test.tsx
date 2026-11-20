import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { EditorView } from "codemirror";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { EDITING_DEFAULTS, type EditingClient } from "../../contracts";
import { EditingPane } from "../components/editing-pane";
import { type FileEditingController, useFileEditing } from "../hooks/use-file-editing";
import { FILE_EDITING_NS, fileEditingResources } from "../i18n";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost" }));
const globals = globalThis as Record<string, unknown>;
const constructors = [
  "CustomEvent",
  "DOMParser",
  "Element",
  "Event",
  "HTMLElement",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "Text",
  "customElements",
  "ResizeObserver",
  "SVGElement",
];
const methods = [
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "getComputedStyle",
  "getSelection",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];
const originals = new Map(
  [...constructors, ...methods, "window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
    key,
    globals[key],
  ]),
);
const i18n = createInstance();
void i18n.init({ lng: "en", initAsync: false, resources: { en: { [FILE_EDITING_NS]: fileEditingResources.en } } });
let root: Root;
let host: HTMLElement;
let controller: FileEditingController;
let client: EditingClient;
let writes: string[];
let restoreEditorFactory = () => {};
function Probe({
  path,
  onQuoteSelection,
}: {
  path: string;
  onQuoteSelection?: (selection: { text: string; location?: string } | null) => void;
}) {
  controller = useFileEditing({ environmentId: "env", client });
  return (
    <I18nextProvider i18n={i18n}>
      <EditingPane controller={controller} path={path} onQuoteSelection={onQuoteSelection} />
    </I18nextProvider>
  );
}
beforeEach(() => {
  const browser = win as unknown as Record<string, unknown>;
  Object.assign(globals, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of constructors) globals[key] = browser[key];
  for (const key of methods) {
    const method = browser[key];
    if (typeof method === "function") globals[key] = method.bind(win);
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  writes = [];
  const unavailable = async (): Promise<never> => {
    throw new Error("Office unavailable");
  };
  client = {
    capabilities: async () => ({
      textMaxBytes: EDITING_DEFAULTS.textMaxBytes,
      office: { enabled: false, extensions: [], maxBytes: EDITING_DEFAULTS.maxFileBytes },
    }),
    readText: async ({ path }) => ({ path, name: path, content: "original", size: 8, version: "v1", encoding: "utf8" }),
    saveText: async ({ path }, content) => {
      writes.push(content);
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

// 编辑面板必须把选区回调传至真实源码编辑器，不能仅让预览入口可用。
test("source editing pane exposes the captured editor selection to its host", async () => {
  const received: string[] = [];
  act(() =>
    root.render(
      <Probe
        path="code.ts"
        onQuoteSelection={(selection) => {
          if (selection) received.push(selection.text);
        }}
      />,
    ),
  );
  await until(() => host.querySelector(".cm-editor") !== null);
  const dom = host.querySelector<HTMLElement>(".cm-editor");
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error("Missing source editor");
  act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));
  act(() => view.contentDOM.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  const quote = document.querySelector<HTMLButtonElement>('[data-selection-action="quote"]');
  expect(quote).not.toBeNull();
  act(() => quote?.click());
  expect(received).toEqual(["orig"]);
});
afterEach(async () => {
  act(() => root.unmount());
  restoreEditorFactory();
  restoreEditorFactory = () => {};
  host.remove();
  await win.happyDOM.abort();
});
afterAll(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}
async function until(predicate: () => boolean) {
  for (let count = 0; count < 150; count++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Editor state did not settle");
}

function button(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

// 只切换编辑方式不得规范化原文，源码修改往返可视化后必须保存同一份草稿。
test("Markdown source mode preserves exact Markdown through visual round trips", async () => {
  const raw = '---\r\n# metadata\r\nname: "a"  \r\n---\r\n\r\n# Title\r\n\r\n<div data-note="raw">Content</div>\r\n';
  client.readText = async ({ path }) => ({
    path,
    name: path,
    content: raw,
    size: raw.length,
    version: "v1",
    encoding: "utf8",
  });
  act(() => root.render(<Probe path="note.md" />));
  await until(() => host.querySelector('.ProseMirror[contenteditable="true"]') !== null);
  act(() => button("Source").click());
  await until(() => host.querySelector(".cm-editor") !== null);
  expect(controller.buffers["note.md"]?.dirty).toBe(false);
  expect(controller.buffers["note.md"]?.content).toBe(raw);
  const dom = host.querySelector<HTMLElement>(".cm-editor");
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error("Missing source editor");
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n<!-- source edit -->" } }));
  const draft = controller.buffers["note.md"]?.content;
  expect(draft).toContain("<!-- source edit -->");
  act(() => button("Visual").click());
  await until(() => host.querySelector('.ProseMirror[contenteditable="true"]') !== null);
  act(() => button("Source").click());
  await until(() => host.querySelector(".cm-editor") !== null);
  expect(controller.buffers["note.md"]?.content).toBe(draft);
  await act(async () => button("Save").click());
  await until(() => writes.length === 1);
  expect(writes).toEqual([draft]);
  expect(controller.buffers["note.md"]?.dirty).toBe(false);
});

// Milkdown 延迟通知不能丢掉切换或快捷键保存之前最后一次真实编辑事务。
test("Markdown flushes the last visual edit before switching to source and saving", async () => {
  const { Editor, editorViewCtx } = await import("@milkdown/kit/core");
  const originalMake = Editor.make;
  let change = (_value: string) => {
    throw new Error("Markdown not ready");
  };
  const make = spyOn(Editor, "make").mockImplementation(() => {
    const editor = originalMake.call(Editor);
    change = (value) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const paragraph = view.state.schema.nodes.paragraph;
        if (!paragraph) throw new Error("Missing paragraph schema");
        view.dispatch(
          view.state.tr.replaceWith(
            0,
            view.state.doc.content.size,
            paragraph.create(null, view.state.schema.text(value)),
          ),
        );
      });
    return editor;
  });
  restoreEditorFactory = () => make.mockRestore();
  act(() => root.render(<Probe path="note.md" />));
  await until(() => host.querySelector('.ProseMirror[contenteditable="true"]') !== null);
  act(() => {
    change("last visual input");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    button("Source").click();
  });
  expect(controller.buffers["note.md"]?.dirty).toBe(true);
  await until(() => host.querySelector(".cm-editor") !== null);
  expect(controller.buffers["note.md"]?.content.trim()).toBe("last visual input");
  act(() => button("Visual").click());
  await until(() => host.querySelector('.ProseMirror[contenteditable="true"]') !== null);
  await act(async () => {
    change("instant save");
    window.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }) as unknown as Event,
    );
  });
  await until(() => writes.length === 1);
  expect(writes[0]?.trim()).toBe("instant save");
  await act(async () => {
    await new Promise((done) => setTimeout(done, 250));
  });
  expect(controller.buffers["note.md"]?.dirty).toBe(false);
  act(() => {
    change("refresh draft");
    button("Refresh").click();
  });
  expect(controller.guard?.paths).toEqual(["note.md"]);
  expect(controller.buffers["note.md"]?.content.trim()).toBe("refresh draft");
  await act(async () => controller.resolveGuard("cancel"));
  expect(controller.buffers["note.md"]?.content.trim()).toBe("refresh draft");
});

// 超限粘贴被控制器拒绝时，源码视图必须回到已接受草稿，不能保存旧正文却显示新正文。
test("CodeMirror rejected paste restores the accepted draft before Save", async () => {
  act(() => root.render(<Probe path="note.txt" />));
  await until(() => host.querySelector(".cm-editor") !== null);
  const dom = host.querySelector(".cm-editor");
  if (!dom) throw new Error("Missing editor");
  const view = EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error("Missing view");
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "draft" } }));
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "x".repeat(EDITING_DEFAULTS.textMaxBytes + 1) },
    }),
  );
  await settle();
  expect(controller.buffers["note.txt"]?.error?.code).toBe("too-large");
  expect(controller.buffers["note.txt"]?.content).toBe("draft");
  expect(view.state.doc.length).toBe(5);
  expect(host.textContent).toContain("Text editing is limited");
  await act(async () => {
    await controller.save("note.txt");
  });
  expect(writes).toEqual(["draft"]);
  expect(view.state.doc.toString()).toBe("draft");
});

// 富文本经过真实 ProseMirror 事务和 Milkdown 序列化，拒绝后同样须恢复可保存正文并保留错误。
test("Markdown rejected paste restores the accepted draft before Save", async () => {
  const { Editor, editorViewCtx } = await import("@milkdown/kit/core");
  const originalMake = Editor.make;
  let replaceMarkdown: (content: string) => void = () => {
    throw new Error("Markdown is not ready");
  };
  const make = spyOn(Editor, "make").mockImplementation(() => {
    const editor = originalMake.call(Editor);
    replaceMarkdown = (content) =>
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const paragraph = view.state.schema.nodes.paragraph;
        if (!paragraph) throw new Error("Markdown paragraph schema is missing");
        view.dispatch(
          view.state.tr.replaceWith(
            0,
            view.state.doc.content.size,
            paragraph.create(null, view.state.schema.text(content)),
          ),
        );
      });
    return editor;
  });
  restoreEditorFactory = () => make.mockRestore();
  act(() => root.render(<Probe path="note.md" />));
  await until(() => host.querySelector('.ProseMirror[contenteditable="true"]') !== null);
  // happy-dom 的直接文本节点变更可能没有进入输入模型；用真实编辑器事务验证后续序列化与保存。
  const typeMarkdown = (content: string) => {
    act(() => replaceMarkdown(content));
  };
  typeMarkdown("draft");
  await until(() => controller.buffers["note.md"]?.dirty === true);
  const accepted = controller.buffers["note.md"]?.content;
  typeMarkdown("x".repeat(EDITING_DEFAULTS.textMaxBytes + 1));
  await until(() => controller.buffers["note.md"]?.error?.code === "too-large");
  await settle();
  await settle();
  expect(controller.buffers["note.md"]?.content).toBe(accepted);
  expect(host.querySelector(".ProseMirror")?.textContent?.length).toBe(5);
  expect(host.textContent).toContain("Text editing is limited");
  await act(async () => {
    await controller.save("note.md");
  });
  expect(writes).toEqual([accepted]);
  expect(host.querySelector(".ProseMirror")?.textContent).toBe("draft");
}, 10000);

// 编辑 DOM 出现不代表异步初始化完成，就绪前必须只读，避免首笔输入被初始化保护静默忽略。
test("Markdown remains read-only until initialization finishes", async () => {
  const { Editor } = await import("@milkdown/kit/core");
  const originalMake = Editor.make;
  let finishStartup!: () => void;
  const pendingStartup = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  const make = spyOn(Editor, "make").mockImplementation(() => {
    const editor = originalMake.call(Editor);
    const create = editor.create;
    editor.create = async () => {
      const value = await create.call(editor);
      await pendingStartup;
      return value;
    };
    return editor;
  });
  try {
    act(() => root.render(<Probe path="initializing.md" />));
    await until(() => host.querySelector(".ProseMirror") !== null);
    expect(host.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("false");
    finishStartup();
    await until(() => host.querySelector('.ProseMirror[contenteditable="true"]') !== null);
    expect(controller.buffers["initializing.md"]?.dirty).toBe(false);
  } finally {
    finishStartup();
    make.mockRestore();
  }
});
