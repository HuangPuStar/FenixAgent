import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditingClient, TextSnapshot } from "../../contracts";
import { type FileEditingController, useFileEditing } from "../hooks/use-file-editing";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost" }));
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
let controller: FileEditingController;
let client: EditingClient;
let disk = new Map<string, TextSnapshot>();
let writes: { content: string; version: string; opId: string }[];
let save: EditingClient["saveText"];
let read: EditingClient["readText"];
function snapshot(path: string, content = "original", version = "v1"): TextSnapshot {
  return { path, content, version, size: new TextEncoder().encode(content).length, name: path, encoding: "utf8" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Probe({ environmentId = "env-a" }: { environmentId?: string }) {
  controller = useFileEditing({ environmentId, client });
  return null;
}
async function flush() {
  await act(async () => {});
}
beforeEach(() => {
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement("div"));
  disk = new Map([["note.md", snapshot("note.md")]]);
  writes = [];
  read = async ({ path }) => disk.get(path) ?? snapshot(path);
  save = async ({ path }, content, options) => {
    writes.push({ content, version: options.expectedVersion, opId: options.opId });
    const next = snapshot(path, content, "v2");
    disk.set(path, next);
    return next;
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Office unavailable");
  };
  client = {
    capabilities: async () => ({
      textMaxBytes: 2097152,
      office: { enabled: false, extensions: [], maxBytes: 96468992 },
    }),
    readText: (...args) => read(...args),
    saveText: (...args) => save(...args),
    openOffice: unavailable,
    saveOffice: unavailable,
    getSession: unavailable,
    overwriteOffice: unavailable,
    closeOffice: unavailable,
    discardOffice: unavailable,
  };
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
});

// 工作区保存必须先等待 iframe 同步，期间新输入不能被旧一代回执清脏。
test("Office save awaits provider sync and retains input made during sync", async () => {
  const sync = deferred<boolean>();
  let commands = 0;
  const session = {
    id: "sync-session",
    state: "editing" as const,
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  };
  client.openOffice = async () => session;
  client.saveOffice = async () => {
    commands++;
    return { saveId: "sync-save" };
  };
  client.getSession = async () => ({ ...session, saveId: "sync-save", lastSavedAt: 1, version: "v2" });
  act(() => {
    void controller.ensureLoaded("sync.docx", "office");
  });
  await flush();
  act(() => controller.markOfficeDirty("sync.docx", true));
  controller.registerOfficeSave("sync.docx", () => sync.promise);
  let saving!: Promise<boolean>;
  act(() => {
    saving = controller.save("sync.docx");
  });
  await flush();
  expect(commands).toBe(0);
  expect(controller.buffers["sync.docx"]?.saving).toBe(true);
  act(() => controller.markOfficeDirty("sync.docx", true));
  sync.resolve(true);
  await act(async () => {
    await saving;
  });
  expect(commands).toBe(1);
  expect(controller.buffers["sync.docx"]?.dirty).toBe(true);
});

// 同步失败或缺少活跃 iframe 都不能伪造保存成功，更不能清除草稿。
test.each([
  "missing",
  "false",
] as const)("Office %s synchronization preserves dirty and sends no save command", async (mode) => {
  let commands = 0;
  client.openOffice = async () => ({
    id: "unsynced",
    state: "editing",
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  });
  client.saveOffice = async () => {
    commands++;
    return { saveId: "false-save" };
  };
  act(() => {
    void controller.ensureLoaded("unsynced.docx", "office");
  });
  await flush();
  act(() => controller.markOfficeDirty("unsynced.docx", true));
  if (mode === "false") controller.registerOfficeSave("unsynced.docx", async () => false);
  let saved = true;
  await act(async () => {
    saved = await controller.save("unsynced.docx");
  });
  expect(saved).toBe(false);
  expect(commands).toBe(0);
  expect(controller.buffers["unsynced.docx"]?.dirty).toBe(true);
  expect(controller.buffers["unsynced.docx"]?.error).toBeTruthy();
});

// 保存后的关闭回执仍可能迟到，新输入不能被关闭收尾移除。
test("new Office edits during close acknowledgement keep the draft and block leave", async () => {
  const close = deferred<void>();
  const session = {
    id: "closing-session",
    state: "editing" as const,
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  };
  client.openOffice = async () => session;
  client.saveOffice = async () => ({ saveId: "closing-save" });
  client.getSession = async () => ({ ...session, saveId: "closing-save", lastSavedAt: 1, version: "v2" });
  client.closeOffice = async () => close.promise;
  act(() => {
    void controller.ensureLoaded("close.docx", "office");
  });
  await flush();
  controller.registerOfficeSave("close.docx", async () => true);
  act(() => controller.markOfficeDirty("close.docx", true));
  let leaving!: Promise<boolean>;
  let decision!: Promise<void>;
  act(() => {
    leaving = controller.beforeLeave();
  });
  act(() => {
    decision = controller.resolveGuard("save");
  });
  await flush();
  act(() => controller.markOfficeDirty("close.docx", true));
  close.resolve();
  await act(async () => {
    await decision;
  });
  expect(controller.buffers["close.docx"]?.dirty).toBe(true);
  expect(controller.guard?.error?.code).toBe("busy");
  await act(async () => {
    await controller.resolveGuard("cancel");
  });
  expect(await leaving).toBe(false);
});

// 冲突覆盖确认的只是原保存代次，冲突后输入不能被旧结果的覆盖回执清脏。
test.each([
  false,
  true,
])("Office overwrite preserves edits newer than conflicted generation (%s)", async (newerInput) => {
  const session = {
    id: "conflict-session",
    state: "editing" as const,
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  };
  client.openOffice = async () => session;
  client.saveOffice = async () => ({ saveId: "conflict-save" });
  client.getSession = async () => ({ ...session, state: "conflict", conflict: true, saveId: "conflict-save" });
  client.overwriteOffice = async () => ({
    ...session,
    saveId: "conflict-save",
    lastSavedAt: 1,
    version: "saved-original-generation",
  });
  act(() => {
    void controller.ensureLoaded("conflict.docx", "office");
  });
  await flush();
  controller.registerOfficeSave("conflict.docx", async () => true);
  act(() => controller.markOfficeDirty("conflict.docx", true));
  await act(async () => {
    await controller.save("conflict.docx");
  });
  if (newerInput) act(() => controller.markOfficeDirty("conflict.docx", true));
  await act(async () => {
    await controller.overwrite("conflict.docx");
  });
  expect(controller.buffers["conflict.docx"]?.dirty).toBe(newerInput);
});

// 服务端保存失败后的重试必须重新发出相同 opId，不能永远只轮询已失败状态。
test("Office failed save retry reissues the same operation and then clears dirty", async () => {
  const operations: string[] = [];
  const session = {
    id: "retry-session",
    state: "editing" as const,
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  };
  client.openOffice = async () => session;
  client.saveOffice = async (_id, opId) => {
    operations.push(opId);
    return { saveId: "retry-save" };
  };
  client.getSession = async () =>
    operations.length === 1
      ? {
          ...session,
          state: "save-failed",
          saveId: "retry-save",
          error: { code: "unavailable", message: "Download failed" },
        }
      : { ...session, saveId: "retry-save", lastSavedAt: 1, version: "v2" };
  act(() => {
    void controller.ensureLoaded("retry.docx", "office");
  });
  await flush();
  controller.registerOfficeSave("retry.docx", async () => true);
  act(() => controller.markOfficeDirty("retry.docx", true));
  await act(async () => {
    await controller.save("retry.docx");
  });
  expect(controller.buffers["retry.docx"]?.dirty).toBe(true);
  await act(async () => {
    await controller.save("retry.docx");
  });
  expect(operations).toHaveLength(2);
  expect(operations[0]).toBe(operations[1]);
  expect(controller.buffers["retry.docx"]?.dirty).toBe(false);
});
