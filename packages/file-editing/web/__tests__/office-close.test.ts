import { afterEach, beforeEach, expect, test } from "bun:test";
import { type EditingClient, EditingError, type OfficeSession } from "../../contracts";
import { EditingStore } from "../hooks/editing-store";

let store: EditingStore;
let client: EditingClient;
let session: OfficeSession;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  session = {
    id: "office-close",
    state: "editing",
    conflict: false,
    version: "v1",
    lastSavedAt: null,
    expiresAt: Date.now() + 100000,
    initialization: { scriptUrl: "https://docs.example.test/api.js", config: {} },
    maxBytes: 96468992,
  };
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected file operation");
  };
  client = {
    capabilities: unused,
    readText: unused,
    saveText: unused,
    openOffice: async () => session,
    saveOffice: async () => ({ saveId: "saved-close" }),
    getSession: async () => ({ ...session, saveId: "saved-close", version: "v2", lastSavedAt: 1 }),
    closeOffice: async () => {},
    discardOffice: unused,
    overwriteOffice: unused,
  };
  store = new EditingStore(client);
  store.connect("env");
  await store.ensureLoaded("office.docx", "office");
  store.registerOfficeSave("office.docx", async () => true);
});
afterEach(() => store.suspend());

// 放弃请求失败后必须恢复未保存状态和保存入口，不能永远停留在保存中。
test("failed discard releases the interrupted Office save for retry", async () => {
  const polling = deferred<OfficeSession>();
  const entered = deferred<void>();
  client.getSession = async () => {
    entered.resolve();
    return polling.promise;
  };
  client.discardOffice = async () => {
    throw new EditingError("unavailable", "Discard failed");
  };
  store.markOfficeDirty("office.docx", true);
  const saving = store.save("office.docx");
  await entered.promise;
  const leaving = store.beforeLeave();
  try {
    await store.resolveGuard("discard");
    expect(store.getSnapshot().guard).toMatchObject({ busy: false, error: { code: "unavailable" } });
    expect(store.buffer("office.docx")).toMatchObject({ saving: false, dirty: true });
    await store.resolveGuard("cancel");
    expect(await leaving).toBe(false);
    polling.resolve(session);
    await saving;
    client.getSession = async () => ({ ...session, saveId: "saved-close", version: "v2", lastSavedAt: 1 });
    expect(await store.save("office.docx")).toBe(true);
  } finally {
    polling.resolve(session);
    await saving;
  }
});

// 删除通知使放弃请求失效时，应结束本次离开并保留草稿，不能锁死确认框。
test.each([false, true])("deletion during Office discard settles the guard (abort=%s)", async (rejectOnAbort) => {
  const cleanup = deferred<void>();
  const entered = deferred<void>();
  client.discardOffice = async (_id, signal) => {
    entered.resolve();
    if (rejectOnAbort)
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    return cleanup.promise;
  };
  store.markOfficeDirty("office.docx", true);
  const leaving = store.beforeLeave();
  const discarding = store.resolveGuard("discard");
  await entered.promise;
  store.notifyPathChange({ moved: [], deleted: ["office.docx"] });
  cleanup.resolve();
  await discarding;
  expect(store.getSnapshot().guard).toBeNull();
  expect(await leaving).toBe(false);
  expect(store.buffer("office.docx")).toMatchObject({ dirty: true, deleted: true });
});

// 旧环境的放弃回调不能关闭新环境正在等待的确认框。
test("an invalidated Office discard leaves a replacement environment guard unchanged", async () => {
  const cleanup = deferred<void>();
  const entered = deferred<void>();
  client.discardOffice = async () => {
    entered.resolve();
    return cleanup.promise;
  };
  store.markOfficeDirty("office.docx", true);
  const oldLeave = store.beforeLeave();
  const discarding = store.resolveGuard("discard");
  await entered.promise;
  store.connect("another-environment");
  await store.ensureLoaded("office.docx", "office");
  store.markOfficeDirty("office.docx", true);
  const newLeave = store.beforeLeave();
  cleanup.resolve();
  await discarding;
  expect(await oldLeave).toBe(false);
  expect(store.getSnapshot().guard).toMatchObject({ paths: ["office.docx"], busy: false });
  await store.resolveGuard("cancel");
  expect(await newLeave).toBe(false);
});

// 保存回执已清脏后关闭必须直接结束会话，不能再弹出未保存提示。
test("saved Office closes without an unsaved-changes prompt", async () => {
  store.markOfficeDirty("office.docx", true);
  expect(await store.save("office.docx")).toBe(true);
  expect(store.buffer("office.docx")?.dirty).toBe(false);
  const closed = deferred<void>();
  client.closeOffice = async () => closed.promise;
  const closing = store.requestClose("office.docx");
  expect(store.getSnapshot().guard).toBeNull();
  expect(store.buffer("office.docx")?.session?.id).toBe("office-close");
  closed.resolve();
  expect(await closing).toBe(true);
  expect(store.buffer("office.docx")).toBeUndefined();
});

// 路由离开和文件操作同样不能把干净 Office 错当成未保存内容。
test("clean Office leave and file-operation guards release sessions without prompting", async () => {
  const leaving = store.beforeLeave();
  expect(store.getSnapshot().guard).toBeNull();
  expect(await leaving).toBe(true);
  expect(store.buffer("office.docx")).toBeUndefined();
  await store.ensureLoaded("office.docx", "office");
  const mutation = store.guardPaths(["office.docx"]);
  expect(store.getSnapshot().guard).toBeNull();
  expect(await mutation).toBe(true);
  expect(store.buffer("office.docx")).toBeUndefined();
});

// 结束会话失败必须保留编辑器并暴露错误，不能误报未保存或静默销毁。
test("failed clean Office close retains the editor with a retriable error", async () => {
  client.closeOffice = async () => {
    throw new EditingError("unavailable", "Close failed");
  };
  const closing = store.requestClose("office.docx");
  expect(store.getSnapshot().guard).toBeNull();
  expect(await closing).toBe(false);
  expect(store.buffer("office.docx")?.error?.code).toBe("unavailable");
  expect(store.buffer("office.docx")?.session?.id).toBe("office-close");
});

// 关闭清单只列出实际未保存内容，未编辑的 Office 仍须在确认后结束会话。
test("the close prompt lists only dirty files while clean Office sessions still close", async () => {
  client.readText = async ({ path }) => ({
    path,
    name: path,
    content: "original",
    size: 8,
    version: "v1",
    encoding: "utf8",
  });
  client.saveText = async ({ path }, content) => ({ path, size: content.length, version: "v2" });
  let officeClosed = false;
  client.closeOffice = async () => {
    officeClosed = true;
  };
  await store.ensureLoaded("probe.txt");
  store.updateContent("probe.txt", "modified");
  const closing = store.beforeLeave();
  expect(store.getSnapshot().guard?.paths).toEqual(["probe.txt"]);
  expect(officeClosed).toBe(false);
  await store.resolveGuard("save");
  expect(await closing).toBe(true);
  expect(officeClosed).toBe(true);
  expect(store.buffer("office.docx")).toBeUndefined();
  expect(store.buffer("probe.txt")).toBeUndefined();
});

// 已保存后继续编辑仍然需要裁决，取消关闭必须保留这次新修改。
test("new Office edits after a committed save still require a close decision", async () => {
  store.markOfficeDirty("office.docx", true);
  expect(await store.save("office.docx")).toBe(true);
  store.markOfficeDirty("office.docx", true);
  const closing = store.requestClose("office.docx");
  expect(store.getSnapshot().guard?.paths).toEqual(["office.docx"]);
  await store.resolveGuard("cancel");
  expect(await closing).toBe(false);
  expect(store.buffer("office.docx")?.dirty).toBe(true);
});

// 关闭期间迟到的编辑不能丢失，已落盘的 closing 回执可完成后续保存关闭。
test("Office edits arriving during close remain guarded and can be saved", async () => {
  const closed = deferred<void>();
  let closeStarted = false;
  client.closeOffice = async () => {
    closeStarted = true;
    return closed.promise;
  };
  client.getSession = async () => ({
    ...session,
    state: "closing",
    saveId: "saved-close",
    version: "v2",
    lastSavedAt: 1,
  });
  const closing = store.requestClose("office.docx");
  expect(closeStarted).toBe(true);
  store.markOfficeDirty("office.docx", true);
  closed.resolve();
  await Bun.sleep(0);
  expect(store.getSnapshot().guard?.paths).toEqual(["office.docx"]);
  expect(store.buffer("office.docx")?.dirty).toBe(true);
  await store.resolveGuard("save");
  expect(await closing).toBe(true);
  expect(store.buffer("office.docx")).toBeUndefined();
});

// 重复关闭和状态轮询不能取消正在结束的会话，也不能制造未保存弹窗。
test("repeated close and status refresh do not interrupt clean Office shutdown", async () => {
  const closed = deferred<void>();
  client.closeOffice = async (_id, signal) => {
    await closed.promise;
    signal?.throwIfAborted();
  };
  const first = store.requestClose("office.docx");
  const second = store.requestClose("office.docx");
  await store.refreshOffice("office.docx");
  expect(store.getSnapshot().guard).toBeNull();
  closed.resolve();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(store.buffer("office.docx")).toBeUndefined();
});

// 连点关闭后出现新编辑时，只能保留一次裁决，取消必须收口两个关闭请求。
test("late edits during repeated close do not strand a close request", async () => {
  const closed = deferred<void>();
  client.closeOffice = async () => closed.promise;
  const results: boolean[] = [];
  void store.requestClose("office.docx").then((allowed) => results.push(allowed));
  void store.requestClose("office.docx").then((allowed) => results.push(allowed));
  store.markOfficeDirty("office.docx", true);
  closed.resolve();
  await Bun.sleep(0);
  await store.resolveGuard("cancel");
  await Bun.sleep(0);
  expect(results).toEqual([false, false]);
  expect(store.buffer("office.docx")?.dirty).toBe(true);
});

// Office 放弃先撤销写权限，再替换 iframe；撤销期间不能并发触发保存。
test("Office discard retains its iframe until revoked and blocks concurrent saving", async () => {
  const discarded = deferred<void>();
  client.discardOffice = async (_id, signal) => {
    await discarded.promise;
    signal?.throwIfAborted();
  };
  client.openOffice = async () => ({ ...session, id: "reloaded-office" });
  store.markOfficeDirty("office.docx", true);
  const reloading = store.reload("office.docx");
  const loading = store.buffer("office.docx")?.loading;
  const existingSession = store.buffer("office.docx")?.session?.id;
  await store.refreshOffice("office.docx");
  const savedDuringDiscard = await store.save("office.docx");
  discarded.resolve();
  await reloading;
  expect(loading).toBe(true);
  expect(existingSession).toBe("office-close");
  expect(savedDuringDiscard).toBe(false);
  expect(store.buffer("office.docx")?.session?.id).toBe("reloaded-office");
  expect(store.buffer("office.docx")?.dirty).toBe(false);
});

// 已失效且没有草稿的会话不能困住用户；服务端已拒绝其后续写入。
test("an already-expired clean Office session can be closed without a decision", async () => {
  client.closeOffice = async () => {
    throw new EditingError("expired", "Session expired");
  };
  const closing = store.requestClose("office.docx");
  expect(store.getSnapshot().guard).toBeNull();
  expect(await closing).toBe(true);
  expect(store.buffer("office.docx")).toBeUndefined();
});
