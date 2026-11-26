import { expect, test } from "bun:test";
import { type EditingClient, EditingError } from "@fenix/file-editing/contracts";
import { act } from "react";
import { I18nextProvider } from "react-i18next";
import {
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
  settle,
  snapshot,
  startEditing,
  Workspace,
  writes,
} from "./workspace-editing-fixture";

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

// 超过文本字节上限时保留禁用入口及悬停原因，不能读取编辑内容或写回文件。
test("oversized text keeps a disabled Edit button with its byte limit", async () => {
  let reads = 0;
  client.readText = async ({ path }) => {
    reads++;
    return snapshot(path);
  };
  fileSizes["above.txt"] = 2098179;
  render(["above.txt"], "above.txt");
  await settle();
  const editButton = button("Edit", host);
  expect(editButton.disabled).toBe(true);
  expect(editButton.closest('[title="Text editing is limited to 2 MiB."]')).not.toBeNull();
  expect(editButton.getAttribute("aria-description")).toBe("Text editing is limited to 2 MiB.");
  act(() => editButton.click());
  await settle();
  expect(reads).toBe(0);
  expect(host.querySelector(".cm-editor")).toBeNull();
  expect(writes).toEqual([]);
});

// 上限以内（含恰好 2 MiB）的文件应可编辑，切换文件不得沿用上一文件的禁用状态。
test.each([2096131, 2097152])("text with %i bytes remains editable after an oversized file", async (size) => {
  fileSizes["above.txt"] = 2098179;
  fileSizes["below.txt"] = size;
  render(["above.txt", "below.txt"], "above.txt");
  await settle();
  expect(button("Edit", host).disabled).toBe(true);
  render(["above.txt", "below.txt"], "below.txt");
  await startEditing();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
});

// 文件缩小后刷新应重新判断编辑能力，不能永久禁用同一个路径。
test("refresh enables editing after an oversized file shrinks", async () => {
  fileSizes["large.txt"] = 2098179;
  render(["large.txt"], "large.txt");
  await settle();
  expect(button("Edit", host).disabled).toBe(true);
  fileSizes["large.txt"] = 8;
  act(() => button("Refresh").click());
  await settle();
  expect(button("Edit", host).disabled).toBe(false);
  await startEditing();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
});

// 同一路径在不同环境对应不同文件，上一环境的大小不能泄漏到新环境。
test("switching environments does not reuse the previous file size", async () => {
  fileSizes["note.txt"] = 2098179;
  render(["note.txt"], "note.txt");
  await settle();
  expect(button("Edit", host).disabled).toBe(true);
  fileSizes["note.txt"] = 8;
  setEnvironment("env-2");
  render(["note.txt"], "note.txt");
  await settle();
  expect(button("Edit", host).disabled).toBe(false);
  await startEditing();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
});

// 文本服务明确拒绝编辑时，保留禁用入口、只读预览和重试能力。
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
  expect(button("Edit", host).disabled).toBe(true);
  expect(button("Edit", host).closest('[title="Text editing is limited to 2 MiB."]')).not.toBeNull();
  client.readText = async ({ path }) => snapshot(path);
  act(() => button("Retry", host).click());
  await ready();
  expect(host.querySelector(".cm-editor")).not.toBeNull();
});

// 服务端拒绝编辑后，可见的只读预览仍应允许选区引用。
test("read-only fallback keeps text selection quoting active", async () => {
  let reads = 0;
  client.readText = async () => {
    reads++;
    throw new EditingError("too-large", "Text is too large");
  };
  const quotes: string[] = [];
  render(["large.txt"], "large.txt", (selection) => {
    if (selection) quotes.push(selection.text);
  });
  await startEditing();
  for (let index = 0; index < 10 && !host.textContent?.includes("Read-only preview"); index++) await settle();
  expect(reads).toBe(1);
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let text: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent === "Read-only preview") {
      text = node;
      break;
    }
  }
  if (!text?.parentElement) throw new Error("Preview text missing");
  const target = text.parentElement;
  const range = document.createRange();
  range.selectNodeContents(text);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  const quote = document.querySelector<HTMLButtonElement>('[data-selection-action="quote"]');
  if (!quote) throw new Error("Quote action missing");
  act(() => quote.click());
  expect(quotes).toEqual(["Read-only preview"]);
  expect(writes).toEqual([]);
});

// 不支持的文件格式也保留编辑入口，明确说明当前格式无法编辑。
test("unsupported formats retain a disabled Edit button with a reason", async () => {
  render(["archive.zip"], "archive.zip");
  await settle();
  expect(button("Edit", host).disabled).toBe(true);
  expect(button("Edit", host).closest('[title="This file type does not support editing."]')).not.toBeNull();
  expect(writes).toEqual([]);
});

// 切环境后迟到的可用能力不得开启新环境不支持的文本或 Office 编辑器。
test.each(["file.docx", "note.txt"])("stale capability results cannot enable editing %s", async (path) => {
  const old = deferred<Awaited<ReturnType<EditingClient["capabilities"]>>>();
  let opens = 0;
  let reads = 0;
  client.readText = async ({ path }) => {
    reads++;
    return snapshot(path);
  };
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
  setEnvironment("env-2");
  render([path], path);
  await settle();
  old.resolve({
    text: { enabled: true },
    textMaxBytes: 2097152,
    office: { enabled: true, extensions: ["docx"], maxBytes: 96468992 },
  });
  await settle();
  expect(opens).toBe(0);
  expect(reads).toBe(0);
  expect(host.querySelector('button[aria-label="Edit"]:not(:disabled)')).toBeNull();
  if (path === "file.docx")
    expect(button("Edit", host).closest('[title="Office editing is unavailable in this environment."]')).not.toBeNull();
  else expect(host.querySelector('button[aria-label="Edit"]')).toBeNull();
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
