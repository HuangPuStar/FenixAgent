import { expect, test } from "bun:test";
import * as Y from "yjs";
import {
  mergeYjsSnapshotWithCas,
  type RedisSnapshotConnection,
  type RedisSnapshotTransaction,
} from "../persist/snapshot-cas";

class InMemorySnapshotStorage implements RedisSnapshotConnection {
  readonly writes: Array<{ key: string; value: Buffer; seconds: number | undefined }> = [];
  readonly watchedKeys: string[][] = [];
  unwatchCalls = 0;
  disconnectCalls = 0;
  private readonly values = new Map<string, Buffer>();
  private readonly strings = new Map<string, string>();
  private readonly execResults: Array<unknown | null>;

  constructor(execResults: Array<unknown | null> = []) {
    this.execResults = execResults;
  }

  setSnapshot(key: string, value: Uint8Array): void {
    this.values.set(key, Buffer.from(value));
  }

  setLegacySnapshot(key: string, value: Uint8Array): void {
    this.values.set(key, Buffer.from(Buffer.from(value).toString("base64")));
  }

  setString(key: string, value: string): void {
    this.strings.set(key, value);
  }

  watch(...keys: string[]): Promise<"OK"> {
    this.watchedKeys.push(keys);
    return Promise.resolve("OK");
  }

  unwatch(): Promise<"OK"> {
    this.unwatchCalls += 1;
    return Promise.resolve("OK");
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  getBuffer(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  multi(): RedisSnapshotTransaction {
    let pending: { key: string; value: Buffer; seconds: number | undefined } | null = null;
    const transaction: RedisSnapshotTransaction = {
      set: (key, value, expiryMode, seconds) => {
        pending = { key, value, seconds: expiryMode === "EX" ? seconds : undefined };
        return transaction;
      },
      exec: async () => {
        const result = this.execResults.length > 0 ? this.execResults.shift()! : [[null, "OK"]];
        if (result !== null && pending) {
          this.values.set(pending.key, pending.value);
          this.writes.push(pending);
        }
        return result;
      },
    };
    return transaction;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

/** 从原始快照恢复 Yjs 状态，便于验证持久化边界而不依赖 Redis。 */
function readSnapshot(snapshot: Buffer): Y.Doc {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(snapshot));
  return ydoc;
}

// 兼容旧 base64 快照时，合并结果仍必须只写入对应 RCS session 的二进制快照并续期 TTL。
test("merges a legacy snapshot without leaking data across RCS session keys", async () => {
  const storage = new InMemorySnapshotStorage();
  const legacy = new Y.Doc();
  legacy.getMap("state").set("fromLegacy", "tenant-a");
  storage.setLegacySnapshot("yjs:chat:rcs_tenant_a", Y.encodeStateAsUpdate(legacy));

  const local = new Y.Doc();
  local.getMap("state").set("fromLocal", "only-a");
  const persisted = await mergeYjsSnapshotWithCas(storage, "yjs:chat:rcs_tenant_a", Y.encodeStateAsUpdate(local), 37);

  const restored = readSnapshot(storage.writes[0]!.value);
  expect(persisted).toBe(true);
  expect(storage.writes).toHaveLength(1);
  expect(storage.writes[0]).toMatchObject({ key: "yjs:chat:rcs_tenant_a", seconds: 37 });
  expect(restored.getMap("state").toJSON()).toEqual({ fromLegacy: "tenant-a", fromLocal: "only-a" });
  expect(storage.writes.some(({ key }) => key.includes("rcs_tenant_b"))).toBe(false);

  legacy.destroy();
  local.destroy();
  restored.destroy();
});

// generation fence 不匹配时必须撤销 WATCH 且拒绝写入，避免已替换的 session 投影回写旧快照。
test("rejects a stale generation fence before writing a snapshot", async () => {
  const storage = new InMemorySnapshotStorage();
  storage.setString("yjs:active-generation:rcs_tenant_a", "gen_current");
  const local = new Y.Doc();

  const persisted = await mergeYjsSnapshotWithCas(
    storage,
    "yjs:session:rcs_tenant_a:gen_stale",
    Y.encodeStateAsUpdate(local),
    60,
    { key: "yjs:active-generation:rcs_tenant_a", generation: "gen_stale" },
  );

  expect(persisted).toBe(false);
  expect(storage.watchedKeys).toEqual([["yjs:session:rcs_tenant_a:gen_stale", "yjs:active-generation:rcs_tenant_a"]]);
  expect(storage.unwatchCalls).toBe(1);
  expect(storage.writes).toEqual([]);

  local.destroy();
});

// CAS 连续冲突耗尽重试次数后必须返回失败，不能写入不确定的快照。
test("returns false after five conflicting snapshot transactions", async () => {
  const storage = new InMemorySnapshotStorage([null, null, null, null, null]);
  const local = new Y.Doc();
  local.getMap("state").set("message", "not persisted");

  const persisted = await mergeYjsSnapshotWithCas(storage, "yjs:chat:rcs_conflicted", Y.encodeStateAsUpdate(local), 60);

  expect(persisted).toBe(false);
  expect(storage.watchedKeys).toHaveLength(5);
  expect(storage.writes).toEqual([]);
  expect(storage.unwatchCalls).toBe(0);

  local.destroy();
});
