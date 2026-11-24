import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type EditingClient, EditingError, type SavedFile, type TextSnapshot } from "../../contracts";
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
async function open(path = "note.md") {
  act(() => {
    void controller.ensureLoaded(path);
  });
  await flush();
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

// 已落盘的一代必须清脏，保存期间的新一代仍须保留。
test("save preserves input typed while the request is pending", async () => {
  const pending = deferred<SavedFile>();
  save = async (_file, content, options) => {
    writes.push({ content, version: options.expectedVersion, opId: options.opId });
    return pending.promise;
  };
  await open();
  act(() => controller.updateContent("note.md", "first"));
  act(() => {
    void controller.save("note.md");
    void controller.save("note.md");
  });
  act(() => controller.updateContent("note.md", "second"));
  pending.resolve({ path: "note.md", size: 5, version: "v2" });
  await flush();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.content).toBe("first");
  expect(controller.buffers["note.md"]?.dirty).toBe(true);
  expect(controller.buffers["note.md"]?.content).toBe("second");
  expect(controller.buffers["note.md"]?.version).toBe("v2");
});

// 正常保存仅需要一次，错误重试应复用原操作身份以避免重写。
test("successful save clears dirty and failed retries reuse operation id", async () => {
  await open();
  const attempts: string[] = [];
  save = async ({ path }, _content, options) => {
    attempts.push(options.opId);
    if (attempts.length === 1) throw new EditingError("unavailable", "Connection lost");
    return { path, size: 6, version: "v2" };
  };
  act(() => controller.updateContent("note.md", "edited"));
  await act(async () => {
    await controller.save("note.md");
  });
  expect(controller.buffers["note.md"]?.error).toBeTruthy();
  await act(async () => {
    await controller.save("note.md");
  });
  expect(controller.buffers["note.md"]?.dirty).toBe(false);
  expect(attempts[0]).toBe(attempts[1]);
});

// 覆盖不是无条件写入，必须先读取目标的新版本再提交原草稿。
test("conflict overwrite rereads and conditionally saves the draft", async () => {
  await open();
  save = async ({ path }, content, options) => {
    writes.push({ content, version: options.expectedVersion, opId: options.opId });
    if (writes.length === 1) throw new EditingError("conflict", "Changed externally");
    return { path, size: content.length, version: "v3" };
  };
  act(() => controller.updateContent("note.md", "my draft"));
  await act(async () => {
    await controller.save("note.md");
  });
  expect(controller.buffers["note.md"]?.conflict).toBe(true);
  disk.set("note.md", snapshot("note.md", "external", "v-external"));
  await act(async () => {
    await controller.overwrite("note.md");
  });
  expect(writes[1]).toMatchObject({ content: "my draft", version: "v-external" });
  expect(controller.buffers["note.md"]?.dirty).toBe(false);
});

// 同一环境再次进入也必须拒绝离开前的旧响应。
test("same environment reentry rejects stale reads and aborts requests", async () => {
  const pending = deferred<TextSnapshot>();
  let oldSignal: AbortSignal | undefined;
  let reads = 0;
  read = async (_file, signal) => {
    reads++;
    if (reads === 1) {
      oldSignal = signal;
      return pending.promise;
    }
    return snapshot("note.md", "new visit");
  };
  act(() => {
    void controller.ensureLoaded("note.md");
  });
  act(() => root.render(<Probe environmentId="env-b" />));
  act(() => root.render(<Probe />));
  await open();
  pending.resolve(snapshot("note.md", "stale"));
  await flush();
  expect(oldSignal?.aborted).toBe(true);
  expect(controller.buffers["note.md"]?.content).toBe("new visit");
});

// 外部整表失效只能替换干净文本，不能覆盖本地草稿。
test("external full invalidation refreshes only clean buffers", async () => {
  await open();
  await open("clean.txt");
  act(() => controller.updateContent("note.md", "local"));
  disk.set("note.md", snapshot("note.md", "remote", "v-external"));
  disk.set("clean.txt", snapshot("clean.txt", "fresh"));
  act(() => controller.notifyFileChange({ kind: "invalidate-all", paths: [] }));
  await flush();
  expect(controller.buffers["note.md"]?.content).toBe("local");
  expect(controller.buffers["note.md"]?.conflict).toBe(true);
  expect(controller.buffers["clean.txt"]?.content).toBe("fresh");
});

// 重复文件事件不能把同版本草稿标记冲突，检测期间继续编辑也不能被异步结果覆盖。
test("external checks preserve the latest draft and compare actual versions", async () => {
  await open();
  act(() => controller.updateContent("note.md", "first draft"));
  act(() => controller.notifyFileChange({ kind: "paths", paths: ["note.md"] }));
  await flush();
  expect(controller.buffers["note.md"]?.conflict).toBe(false);
  const pending = deferred<TextSnapshot>();
  read = async () => pending.promise;
  act(() => controller.notifyFileChange({ kind: "paths", paths: ["note.md"] }));
  act(() => controller.updateContent("note.md", "latest draft"));
  pending.resolve(snapshot("note.md", "external", "v-external"));
  await flush();
  expect(controller.buffers["note.md"]?.content).toBe("latest draft");
  expect(controller.buffers["note.md"]?.version).toBe("v1");
  expect(controller.buffers["note.md"]?.conflict).toBe(true);
});

// 关闭、离开与文件操作共用裁决，取消不能丢草稿。
test("guard cancel preserves draft and discard resolves close", async () => {
  await open();
  act(() => controller.updateContent("note.md", "draft"));
  let closing!: Promise<boolean>;
  act(() => {
    closing = controller.requestClose("note.md");
  });
  expect(controller.guard?.paths).toEqual(["note.md"]);
  await act(async () => {
    await controller.resolveGuard("cancel");
  });
  expect(await closing).toBe(false);
  expect(controller.buffers["note.md"]?.content).toBe("draft");
  act(() => {
    closing = controller.requestClose("note.md");
  });
  await act(async () => {
    await controller.resolveGuard("discard");
  });
  expect(await closing).toBe(true);
  expect(controller.buffers["note.md"]).toBeUndefined();
});

// 路径重映射保留草稿，删除通知不能复活或静默丢失它。
test("path mutations preserve draft and deleted draft requires a decision", async () => {
  await open();
  act(() => controller.updateContent("note.md", "draft"));
  act(() => controller.notifyPathChange({ moved: [{ oldPath: "note.md", newPath: "renamed.md" }], deleted: [] }));
  expect(controller.buffers["renamed.md"]?.content).toBe("draft");
  expect(controller.dirtyPaths).toEqual(["renamed.md"]);
  act(() => controller.notifyPathChange({ moved: [], deleted: ["renamed.md"] }));
  expect(controller.buffers["renamed.md"]?.deleted).toBe(true);
  expect(controller.buffers["renamed.md"]?.dirty).toBe(true);
});

// 缓冲区满时只能淘汰干净文件，2 MiB 上限按 UTF-8 字节计算。
test("budget refuses dirty eviction and rejects oversized UTF8 text", async () => {
  for (let index = 0; index < 50; index++) {
    const path = `${index}.txt`;
    await open(path);
    act(() => controller.updateContent(path, "draft"));
  }
  await open("extra.txt");
  expect(Object.keys(controller.buffers)).toHaveLength(50);
  expect(controller.error?.code).toBe("busy");
  act(() => controller.updateContent("0.txt", "中".repeat(700000)));
  expect(controller.buffers["0.txt"]?.content).toBe("draft");
  expect(controller.buffers["0.txt"]?.error?.code).toBe("too-large");
});

// Office 只有匹配的真正落盘回执才能清脏，提供方缓存同步事件不能清脏。
test("Office save waits for matching receipt and preserves newer input", async () => {
  const pendingStatus = deferred<Awaited<ReturnType<EditingClient["getSession"]>>>();
  let accepted = false;
  const session = {
    id: "office-1",
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
    accepted = true;
    return { saveId: "save-1" };
  };
  client.getSession = async () => pendingStatus.promise;
  await open("document.docx");
  // 在同一路径没有启动文本读取；Office family 由调用方显式指定。
  act(() => {
    void controller.ensureLoaded("office.docx", "office");
  });
  await flush();
  controller.registerOfficeSave("office.docx", async () => true);
  act(() => controller.markOfficeDirty("office.docx", true));
  let result!: Promise<boolean>;
  act(() => {
    result = controller.save("office.docx");
  });
  await flush();
  expect(accepted).toBe(true);
  expect(controller.buffers["office.docx"]?.saving).toBe(true);
  act(() => {
    controller.markOfficeDirty("office.docx", false);
    controller.markOfficeDirty("office.docx", true);
  });
  pendingStatus.resolve({ ...session, state: "editing", saveId: "save-1", lastSavedAt: 1, version: "v2" });
  await act(async () => {
    await result;
  });
  expect(controller.buffers["office.docx"]?.dirty).toBe(true);
  expect(controller.buffers["office.docx"]?.version).toBe("v2");
});

// 放弃文档必须在销毁 iframe 的关闭许可之前由服务器确认。
test("Office discard must finish before close is allowed", async () => {
  const discarded = deferred<void>();
  client.openOffice = async () => ({
    id: "office-2",
    state: "editing",
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  });
  client.discardOffice = async () => discarded.promise;
  act(() => {
    void controller.ensureLoaded("office.docx", "office");
  });
  await flush();
  act(() => controller.markOfficeDirty("office.docx", true));
  let closed = false;
  act(() => {
    void controller.requestClose("office.docx").then((allowed) => {
      closed = allowed;
    });
  });
  act(() => {
    void controller.resolveGuard("discard");
  });
  await flush();
  expect(closed).toBe(false);
  expect(controller.buffers["office.docx"]?.session?.id).toBe("office-2");
  discarded.resolve();
  await flush();
  expect(closed).toBe(true);
  expect(controller.buffers["office.docx"]).toBeUndefined();
});

// 过期错误必须可见并保留文档内容供恢复，不得自动移除编辑器。
test("Office expiry retains dirty session with visible failure", async () => {
  const session = {
    id: "office-3",
    state: "editing" as const,
    conflict: false,
    lastSavedAt: null,
    version: "v1",
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  };
  client.openOffice = async () => session;
  client.getSession = async () => ({ ...session, state: "expired" });
  act(() => {
    void controller.ensureLoaded("office.docx", "office");
  });
  await flush();
  act(() => controller.markOfficeDirty("office.docx", true));
  await act(async () => {
    await controller.refreshOffice("office.docx");
  });
  expect(controller.buffers["office.docx"]?.dirty).toBe(true);
  expect(controller.buffers["office.docx"]?.error?.code).toBe("expired");
  expect(controller.buffers["office.docx"]?.session?.id).toBe("office-3");
});

// 宿主切换环境会卸载工作区；控制器只持有当前环境的缓冲区。
test("environment switch releases the previous environment buffers", async () => {
  for (let index = 0; index < 50; index++) {
    const path = `${index}.txt`;
    await open(path);
    act(() => controller.updateContent(path, "draft"));
  }
  act(() => root.render(<Probe environmentId="env-b" />));
  await open("extra.txt");
  expect(Object.keys(controller.buffers)).toEqual(["extra.txt"]);
  expect(controller.error).toBeNull();
});

// 离开裁决中的旧保存结束后，不能把旧对话框或副作用带到新环境。
test("environment switch invalidates a pending leave decision", async () => {
  const pending = deferred<SavedFile>();
  save = async () => pending.promise;
  await open();
  act(() => controller.updateContent("note.md", "old draft"));
  act(() => {
    void controller.beforeLeave();
  });
  act(() => {
    void controller.resolveGuard("save");
  });
  act(() => root.render(<Probe environmentId="env-b" />));
  await open();
  act(() => controller.updateContent("note.md", "new draft"));
  pending.resolve({ path: "note.md", size: 9, version: "v2" });
  await flush();
  expect(controller.guard).toBeNull();
  expect(controller.buffers["note.md"]?.content).toBe("new draft");
  expect(controller.buffers["note.md"]?.dirty).toBe(true);
});

// 干净草稿按最近访问淘汰，切回过的文件不能被当作最老文件丢弃。
test("clean buffer eviction respects recent visits", async () => {
  for (let index = 0; index < 50; index++) await open(`${index}.txt`);
  await open("0.txt");
  await open("extra.txt");
  expect(controller.buffers["0.txt"]?.content).toBe("original");
  expect(controller.buffers["1.txt"]).toBeUndefined();
});

// 宿主重新生成 transport adapter 不得重置同一路径的未保存草稿。
test("client identity changes do not discard drafts", async () => {
  await open();
  act(() => controller.updateContent("note.md", "draft"));
  client = { ...client };
  act(() => root.render(<Probe />));
  expect(controller.buffers["note.md"]?.content).toBe("draft");
  expect(controller.dirtyPaths).toEqual(["note.md"]);
});
