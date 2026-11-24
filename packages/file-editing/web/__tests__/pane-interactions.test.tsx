import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { type EditingClient, EditingError, type OfficeSession } from "../../contracts";

let EditingDialogs: typeof import("../components/editing-dialogs").EditingDialogs;
let EditingPane: typeof import("../components/editing-pane").EditingPane;

import { type FileEditingController, useFileEditing } from "../hooks/use-file-editing";
import { FILE_EDITING_NS, fileEditingResources } from "../i18n";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost" }));
const i18n = createInstance();
void i18n.init({ lng: "en", initAsync: false, resources: { en: { [FILE_EDITING_NS]: fileEditingResources.en } } });
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
let controller: FileEditingController;
let client: EditingClient;
let failRead = false;
let writes: string[];
function Probe({ second = false, office = false }: { second?: boolean; office?: boolean }) {
  controller = useFileEditing({ environmentId: "env-1", client });
  return (
    <I18nextProvider i18n={i18n}>
      <EditingPane
        controller={controller}
        path={office ? "active.docx" : "active.txt"}
        kind={office ? "office" : "text"}
      />
      {second && <EditingPane controller={controller} path="inactive.txt" active={false} />}
      <EditingDialogs controller={controller} />
    </I18nextProvider>
  );
}
beforeEach(async () => {
  const globals = globalThis as Record<string, unknown>;
  const browser = win as unknown as Record<string, unknown>;
  Object.assign(globals, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of [
    "CustomEvent",
    "MutationObserver",
    "HTMLElement",
    "HTMLInputElement",
    "Node",
    "NodeFilter",
    "Text",
    "Element",
    "DocumentFragment",
    "Event",
    "KeyboardEvent",
  ])
    globals[key] = browser[key];
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    const value = browser[key];
    if (typeof value === "function") globals[key] = value.bind(win);
  }
  ({ EditingDialogs } = await import("../components/editing-dialogs"));
  ({ EditingPane } = await import("../components/editing-pane"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  writes = [];
  failRead = false;
  const unavailable = async (): Promise<never> => {
    throw new Error("Office unavailable");
  };
  client = {
    capabilities: async () => ({
      textMaxBytes: 2097152,
      office: { enabled: false, extensions: [], maxBytes: 96468992 },
    }),
    readText: async ({ path }) => {
      if (failRead) throw new EditingError("unavailable", "Read unavailable");
      return { path, name: path, content: "original", size: 8, version: "v1", encoding: "utf8" };
    },
    saveText: async ({ path }, content) => {
      writes.push(path);
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
});
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}
function button(label: string, parent: ParentNode = host): HTMLButtonElement {
  const element = [...parent.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element as HTMLButtonElement;
}
function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="alertdialog"]');
  if (!dialog) throw new Error("Missing confirmation dialog");
  return button(label, dialog);
}

function officeSession(id: string): OfficeSession {
  return {
    id,
    state: "editing",
    conflict: false,
    version: id,
    lastSavedAt: null,
    expiresAt: Date.now() + 60000,
    maxBytes: 96468992,
    initialization: { scriptUrl: "https://docs.example.test/editor-refresh.js", config: {} },
  };
}

function mockOfficeBrowser() {
  const previousAppend = document.head.appendChild;
  const browser = window as unknown as { DocsAPI?: unknown };
  const previousApi = browser.DocsAPI;
  browser.DocsAPI = {
    DocEditor: class {
      destroyEditor() {}
    },
  };
  document.head.appendChild = <T extends Node>(node: T): T => {
    if (node.nodeName === "SCRIPT") {
      queueMicrotask(() => node.dispatchEvent(new win.Event("load") as unknown as Event));
      return node;
    }
    return previousAppend.call(document.head, node) as T;
  };
  return () => {
    document.head.appendChild = previousAppend;
    if (previousApi === undefined) delete browser.DocsAPI;
    else browser.DocsAPI = previousApi;
  };
}

// 干净文件也能在编辑器内刷新，重新读取 Agent 写入的当前版本。
test("editor toolbar Refresh reloads a clean file without a confirmation", async () => {
  let disk = "initial";
  client.readText = async ({ path }) => ({
    path,
    name: path,
    content: disk,
    size: disk.length,
    version: disk,
    encoding: "utf8",
  });
  act(() => root.render(<Probe />));
  await settle();
  disk = "agent update";
  expect(button("Refresh").disabled).toBe(false);
  await act(async () => button("Refresh").click());
  await settle();
  expect(controller.buffers["active.txt"]?.content).toBe("agent update");
  expect(controller.buffers["active.txt"]?.dirty).toBe(false);
  expect(controller.guard).toBeNull();
  expect(writes).toEqual([]);
});

// 刷新前有草稿时先裁决，取消保留原文，放弃后才重新读取磁盘。
test("editor toolbar Refresh preserves dirty edits on Cancel and reloads on Discard", async () => {
  act(() => root.render(<Probe />));
  await settle();
  act(() => controller.updateContent("active.txt", "unsaved draft"));
  act(() => button("Refresh").click());
  await settle();
  act(() => dialogButton("Cancel").click());
  expect(controller.buffers["active.txt"]?.content).toBe("unsaved draft");
  act(() => button("Refresh").click());
  await settle();
  await act(async () => dialogButton("Discard").click());
  await settle();
  expect(controller.buffers["active.txt"]?.content).toBe("original");
  expect(controller.buffers["active.txt"]?.dirty).toBe(false);
  expect(writes).toEqual([]);
});

// 首次加载卡住时编辑器刷新入口仍可用，旧响应迟到也不能覆盖重试结果。
test("editor toolbar Refresh supersedes an unfinished read", async () => {
  let finishFirst!: (value: Awaited<ReturnType<EditingClient["readText"]>>) => void;
  let reads = 0;
  client.readText = async ({ path }) => {
    if (++reads === 1)
      return new Promise((resolve) => {
        finishFirst = resolve;
      });
    return { path, name: path, content: "fresh", size: 5, version: "v2", encoding: "utf8" };
  };
  act(() => root.render(<Probe />));
  await settle();
  expect(button("Refresh").disabled).toBe(false);
  await act(async () => button("Refresh").click());
  await settle();
  finishFirst({ path: "active.txt", name: "active.txt", content: "stale", size: 5, version: "v1", encoding: "utf8" });
  await settle();
  expect(controller.buffers["active.txt"]?.content).toBe("fresh");
});

// 保存中的刷新不能打断写入；选择保存后应等待回执，再加载已提交文件。
test("editor toolbar Refresh waits for an in-flight save before reloading", async () => {
  let finishSave!: () => void;
  let disk = "original";
  client.readText = async ({ path }) => ({
    path,
    name: path,
    content: disk,
    size: disk.length,
    version: disk,
    encoding: "utf8",
  });
  client.saveText = async ({ path }, content) => {
    await new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    disk = content;
    return { path, size: content.length, version: "saved" };
  };
  act(() => root.render(<Probe />));
  await settle();
  act(() => controller.updateContent("active.txt", "saved draft"));
  act(() => button("Save").click());
  expect(button("Refresh").disabled).toBe(false);
  act(() => button("Refresh").click());
  await settle();
  expect(controller.guard).toBeNull();
  await act(async () => finishSave());
  await settle();
  expect(controller.buffers["active.txt"]?.content).toBe("saved draft");
  expect(controller.buffers["active.txt"]?.dirty).toBe(false);
  expect(controller.guard).toBeNull();
});

// Office 刷新先结束旧会话，失败保留编辑器，重试成功后才获取新版本。
test("editor toolbar Refresh retains Office on close failure and reopens it on retry", async () => {
  const restore = mockOfficeBrowser();
  const events: string[] = [];
  let opened = 0;
  let occupied = false;
  let failClose = true;
  client.openOffice = async () => {
    if (occupied) throw new EditingError("busy", "File already has an editing session");
    occupied = true;
    const id = `office-refresh-${++opened}`;
    events.push(`open:${id}`);
    return officeSession(id);
  };
  client.closeOffice = async (id) => {
    if (failClose) throw new EditingError("unavailable", "Close unavailable");
    events.push(`close:${id}`);
  };
  client.discardOffice = async (id) => {
    if (failClose) throw new EditingError("unavailable", "Close unavailable");
    occupied = false;
    events.push(`discard:${id}`);
  };
  try {
    act(() => root.render(<Probe office />));
    await settle();
    await act(async () => button("Refresh").click());
    await settle();
    expect(controller.buffers["active.docx"]?.session?.id).toBe("office-refresh-1");
    expect(host.textContent).toContain("Close unavailable");
    failClose = false;
    await act(async () => button("Refresh").click());
    await settle();
    expect(controller.buffers["active.docx"]?.session?.id).toBe("office-refresh-2");
    expect(events).toEqual(["open:office-refresh-1", "discard:office-refresh-1", "open:office-refresh-2"]);
  } finally {
    restore();
  }
});

// 过期后的提示动作应重建会话，而不是反复查询已经不可恢复的旧会话。
test.each(["expired", "closed", "missing"] as const)("Office %s recovers through Refresh editor", async (state) => {
  const restore = mockOfficeBrowser();
  let opened = 0;
  let polls = 0;
  client.openOffice = async () => officeSession(`session-${++opened}`);
  client.getSession = async (id) => {
    polls++;
    if (state === "missing") throw new EditingError("not-found", "Session unavailable");
    return { ...officeSession(id), state };
  };
  client.discardOffice = async () => {};
  try {
    act(() => root.render(<Probe office />));
    await settle();
    await act(async () => controller.refreshOffice("active.docx"));
    expect(host.textContent).toContain("Refresh the editor");
    const banner = host.querySelector('[role="alert"]');
    if (!banner) throw new Error("Missing expiry banner");
    await act(async () => button("Refresh editor", banner).click());
    await settle();
    expect(controller.buffers["active.docx"]?.session?.id).toBe("session-2");
    expect(controller.buffers["active.docx"]?.error).toBeNull();
    expect(polls).toBe(1);
  } finally {
    restore();
  }
});

// 过期的脏文档必须保留旧编辑器供复制，取消不丢稿，不能引导用户保存到过期会话。
test("expired Office refresh protects unsaved content with Cancel or Discard", async () => {
  const restore = mockOfficeBrowser();
  let opened = 0;
  client.openOffice = async () => officeSession(`draft-${++opened}`);
  client.getSession = async (id) => ({ ...officeSession(id), state: "expired" });
  client.discardOffice = async () => {};
  try {
    act(() => root.render(<Probe office />));
    await settle();
    act(() => controller.markOfficeDirty("active.docx", true));
    await act(async () => controller.refreshOffice("active.docx"));
    expect(button("Save").disabled).toBe(true);
    act(() => button("Refresh editor").click());
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Copy any content you need");
    expect([...dialog!.querySelectorAll("button")].some((item) => item.textContent === "Save")).toBe(false);
    act(() => dialogButton("Cancel").click());
    expect(controller.buffers["active.docx"]?.session?.id).toBe("draft-1");
    expect(controller.buffers["active.docx"]?.dirty).toBe(true);
    act(() => button("Refresh editor").click());
    await settle();
    await act(async () => dialogButton("Discard").click());
    await settle();
    expect(controller.buffers["active.docx"]?.session?.id).toBe("draft-2");
    expect(controller.buffers["active.docx"]?.dirty).toBe(false);
  } finally {
    restore();
  }
});

// 临时网络错误仍应重试原会话，不能以重开文档的方式丢弃脏内容。
test("Office network Retry keeps the current dirty session", async () => {
  const restore = mockOfficeBrowser();
  client.openOffice = async () => officeSession("network-session");
  client.getSession = async () => {
    throw new EditingError("unavailable", "Network unavailable");
  };
  try {
    act(() => root.render(<Probe office />));
    await settle();
    act(() => controller.markOfficeDirty("active.docx", true));
    await act(async () => controller.refreshOffice("active.docx"));
    client.getSession = async () => officeSession("network-session");
    await act(async () => button("Retry").click());
    expect(controller.buffers["active.docx"]?.session?.id).toBe("network-session");
    expect(controller.buffers["active.docx"]?.dirty).toBe(true);
    expect(controller.buffers["active.docx"]?.error).toBeNull();
  } finally {
    restore();
  }
});

// 保存按钮必须驱动真实控制器清脏，全屏切换不能重建或丢掉草稿。
test("pane Save persists the draft and fullscreen keeps its buffer", async () => {
  act(() => root.render(<Probe />));
  await settle();
  act(() => controller.updateContent("active.txt", "draft"));
  act(() => button("Expand editor").click());
  expect(controller.buffers["active.txt"]?.content).toBe("draft");
  act(() => button("Save").click());
  await settle();
  expect(writes).toEqual(["active.txt"]);
  expect(controller.buffers["active.txt"]?.dirty).toBe(false);
  expect(host.textContent).toContain("Saved");
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(host.querySelector(".fixed.inset-0")).toBeNull();
  expect(controller.buffers["active.txt"]?.version).toBe("v2");
});

// 用户可在裁决对话框中取消离开，草稿和后续放弃流程必须仍然可用。
test("dialog Cancel preserves draft and Discard authorizes close", async () => {
  act(() => root.render(<Probe />));
  await settle();
  act(() => controller.updateContent("active.txt", "draft"));
  let closing!: Promise<boolean>;
  act(() => {
    closing = controller.requestClose("active.txt");
  });
  await settle();
  act(() => dialogButton("Cancel").click());
  expect(await closing).toBe(false);
  expect(controller.buffers["active.txt"]?.content).toBe("draft");
  act(() => {
    closing = controller.requestClose("active.txt");
  });
  await settle();
  act(() => dialogButton("Discard").click());
  await settle();
  expect(await closing).toBe(true);
  expect(controller.buffers["active.txt"]).toBeUndefined();
});

// 保活但隐藏的 Office/编辑标签不能监听全局保存并意外写入非活动文件。
test("global save shortcut only saves the active pane", async () => {
  act(() => root.render(<Probe second />));
  await settle();
  await act(async () => controller.ensureLoaded("inactive.txt"));
  act(() => {
    controller.updateContent("active.txt", "a");
    controller.updateContent("inactive.txt", "b");
  });
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }));
  });
  await settle();
  expect(writes).toEqual(["active.txt"]);
  expect(controller.buffers["inactive.txt"]?.dirty).toBe(true);
});

// 工具栏放弃须先确认；取消保留草稿，确认只读取磁盘而不执行保存。
test("toolbar Discard keeps edits on cancel and reloads the disk version on confirmation", async () => {
  act(() => root.render(<Probe />));
  await settle();
  act(() => controller.updateContent("active.txt", "draft to discard"));
  act(() => button("Discard").click());
  await settle();
  act(() => dialogButton("Cancel").click());
  expect(controller.buffers["active.txt"]?.content).toBe("draft to discard");
  expect(controller.buffers["active.txt"]?.dirty).toBe(true);
  act(() => button("Discard").click());
  await settle();
  act(() => dialogButton("Discard").click());
  await settle();
  expect(controller.buffers["active.txt"]?.content).toBe("original");
  expect(controller.buffers["active.txt"]?.dirty).toBe(false);
  expect(writes).toEqual([]);
});

// 读取失败需在界面显式提示，并提供无需丢弃草稿控制器的重试入口。
test("read error is visible and Retry opens the editor", async () => {
  failRead = true;
  act(() => root.render(<Probe />));
  await settle();
  expect(host.textContent).toContain("Read unavailable");
  failRead = false;
  act(() => button("Retry").click());
  await settle();
  expect(controller.buffers["active.txt"]?.content).toBe("original");
  expect(controller.buffers["active.txt"]?.error).toBeNull();
});
