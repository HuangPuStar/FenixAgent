import { expect, test } from "bun:test";
import type { EditingClient, SavedFile } from "../../contracts";
import { EditingStore } from "../hooks/editing-store";

function fixture() {
  let resolve!: (file: SavedFile) => void;
  const pending = new Promise<SavedFile>((done) => {
    resolve = done;
  });
  let content = "original";
  let version = "v1";
  let reads = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error("Office is outside this text fixture");
  };
  const client: EditingClient = {
    capabilities: async () => ({
      textMaxBytes: 2097152,
      office: { enabled: false, extensions: [], maxBytes: 96468992 },
    }),
    readText: async ({ path }) => {
      reads++;
      return { path, name: path, content, version, size: content.length, encoding: "utf8" };
    },
    saveText: async (_file, text) => {
      content = text;
      version = "v2";
      return pending;
    },
    openOffice: unavailable,
    saveOffice: unavailable,
    getSession: unavailable,
    overwriteOffice: unavailable,
    closeOffice: unavailable,
    discardOffice: unavailable,
  };
  const store = new EditingStore(client);
  store.connect("environment-a");
  return {
    store,
    reads: () => reads,
    external: () => {
      content = "external version";
      version = "v3";
    },
    finish: () => resolve({ path: "note.txt", size: 5, version: "v2" }),
  };
}

// 保存期间的外部变化和全量刷新需要合并，在回执结束后重新读取干净内容。
test("rechecks a clean buffer once after changes received during save", async () => {
  const f = fixture();
  await f.store.ensureLoaded("note.txt");
  f.store.updateContent("note.txt", "saved");
  const saving = f.store.save("note.txt");
  f.external();
  f.store.notifyFileChange({ kind: "paths", paths: ["note.txt"] });
  f.store.notifyFileChange({ kind: "invalidate-all", paths: [] });
  expect(f.reads()).toBe(1);
  f.finish();
  await saving;
  await Promise.resolve();
  expect(f.store.buffer("note.txt")?.content).toBe("external version");
  expect(f.store.buffer("note.txt")?.version).toBe("v3");
  expect(f.reads()).toBe(2);
});

// 保存途中继续输入的新草稿不能被补查覆盖，外部新版本应标记为冲突。
test("retains newer typing and marks conflict after a deferred external check", async () => {
  const f = fixture();
  await f.store.ensureLoaded("note.txt");
  f.store.updateContent("note.txt", "saved");
  const saving = f.store.save("note.txt");
  f.store.updateContent("note.txt", "newer draft");
  f.external();
  f.store.notifyFileChange({ kind: "invalidate-all", paths: [] });
  f.finish();
  await saving;
  await Promise.resolve();
  expect(f.store.buffer("note.txt")?.content).toBe("newer draft");
  expect(f.store.buffer("note.txt")?.dirty).toBe(true);
  expect(f.store.buffer("note.txt")?.conflict).toBe(true);
});

// 环境换代必须清除待补查通知，旧保存完成后不能读取或改写新环境。
test("drops deferred notifications when the environment changes", async () => {
  const f = fixture();
  await f.store.ensureLoaded("note.txt");
  f.store.updateContent("note.txt", "saved");
  const saving = f.store.save("note.txt");
  f.store.notifyFileChange({ kind: "invalidate-all", paths: [] });
  f.store.connect("environment-b");
  f.finish();
  await saving;
  await Promise.resolve();
  expect(f.reads()).toBe(1);
  expect(f.store.getSnapshot().buffers).toEqual({});
});
