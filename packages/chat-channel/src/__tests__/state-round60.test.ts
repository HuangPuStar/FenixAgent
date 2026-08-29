import { expect, test } from "bun:test";
import * as Y from "yjs";
import { buildRedisProviderKeys } from "../persist/redis";
import {
  mergeYjsSnapshotWithCas,
  persistYjsClearedSnapshotWithCas,
  type RedisSnapshotConnection,
  type RedisSnapshotTransaction,
} from "../persist/snapshot-cas";

type Write = { key: string; value: Buffer; seconds: number | undefined };

class MemorySnapshotConnection implements RedisSnapshotConnection {
  readonly values = new Map<string, Buffer>();
  readonly strings = new Map<string, string>();
  readonly watchedKeys: string[][] = [];
  readonly writes: Write[] = [];
  readonly execResults: Array<unknown | null>;
  unwatchCalls = 0;
  disconnectCalls = 0;
  failWatch = false;
  failRead = false;
  failExec = false;
  onConflict: (() => void) | undefined;

  constructor(execResults: Array<unknown | null> = []) {
    this.execResults = execResults;
  }

  watch(...keys: string[]): Promise<"OK"> {
    this.watchedKeys.push(keys);
    if (this.failWatch) return Promise.reject(new Error("watch failed"));
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
    if (this.failRead) return Promise.reject(new Error("read failed"));
    return Promise.resolve(this.values.get(key) ?? null);
  }

  multi(): RedisSnapshotTransaction {
    let pending: Write | undefined;
    const transaction: RedisSnapshotTransaction = {
      set: (key, value, expiryMode, seconds) => {
        pending = { key, value, seconds: expiryMode === "EX" ? seconds : undefined };
        return transaction;
      },
      exec: async () => {
        if (this.failExec) throw new Error("exec failed");
        const result = this.execResults.length > 0 ? this.execResults.shift()! : [[null, "OK"]];
        if (result === null) {
          this.onConflict?.();
        } else if (pending) {
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

class MemoryRedis {
  readonly persistence: MemorySnapshotConnection;

  constructor(persistence: MemorySnapshotConnection) {
    this.persistence = persistence;
  }

  duplicate(): MemorySnapshotConnection {
    return this.persistence;
  }
}

function updateWith(key: string, value: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("state").set(key, value);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function snapshotValue(snapshot: Buffer, key: string): unknown {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(snapshot));
  const value = doc.getMap("state").get(key);
  doc.destroy();
  return value;
}

function clearState(doc: Y.Doc): void {
  doc.getMap("state").clear();
}

function prepareClearedTarget(
  storage: MemorySnapshotConnection,
  rcsSessionId: string,
  generation: string,
): { target: { rcsSessionId: string; generation: string }; snapshotKey: string } {
  const keys = buildRedisProviderKeys(`session:${rcsSessionId}`, generation);
  storage.strings.set(keys.activeGenerationKey, generation);
  return { target: { rcsSessionId, generation }, snapshotKey: keys.snapshotKey };
}

// 空快照写入必须仅持久化当前会话键，并保留指定的 TTL。
test("空快照写入隔离当前会话并设置 TTL", async () => {
  const storage = new MemorySnapshotConnection();

  const persisted = await mergeYjsSnapshotWithCas(storage, "snapshot:session-a", updateWith("message", "a"), 31);

  expect(persisted).toBe(true);
  expect(storage.writes).toHaveLength(1);
  expect(storage.writes[0]).toMatchObject({ key: "snapshot:session-a", seconds: 31 });
  expect(snapshotValue(storage.writes[0]!.value, "message")).toBe("a");
});

// 同一会话的远端和本地 Yjs 更新必须无损合并。
test("同会话快照合并远端与本地更新", async () => {
  const storage = new MemorySnapshotConnection();
  storage.values.set("snapshot:session-a", Buffer.from(updateWith("remote", "kept")));

  await mergeYjsSnapshotWithCas(storage, "snapshot:session-a", updateWith("local", "added"), 32);

  expect(snapshotValue(storage.writes[0]!.value, "remote")).toBe("kept");
  expect(snapshotValue(storage.writes[0]!.value, "local")).toBe("added");
});

// 其他会话的快照不得被当前会话的写入读取或覆盖。
test("跨会话快照保持数据隔离", async () => {
  const storage = new MemorySnapshotConnection();
  storage.values.set("snapshot:session-b", Buffer.from(updateWith("secret", "b-only")));

  await mergeYjsSnapshotWithCas(storage, "snapshot:session-a", updateWith("message", "a-only"), 33);

  expect(snapshotValue(storage.writes[0]!.value, "secret")).toBeUndefined();
  expect(snapshotValue(storage.values.get("snapshot:session-b")!, "secret")).toBe("b-only");
});

// 旧版 base64 快照必须兼容读取，并改写为可直接应用的二进制快照。
test("兼容旧版 base64 快照并输出二进制更新", async () => {
  const storage = new MemorySnapshotConnection();
  storage.values.set("snapshot:legacy", Buffer.from(Buffer.from(updateWith("old", "legacy")).toString("base64")));

  await mergeYjsSnapshotWithCas(storage, "snapshot:legacy", updateWith("new", "current"), 34);

  expect(snapshotValue(storage.writes[0]!.value, "old")).toBe("legacy");
  expect(snapshotValue(storage.writes[0]!.value, "new")).toBe("current");
});

// generation fence 匹配时必须同时 WATCH 快照键和 fence 键后才允许写入。
test("匹配的 generation fence 允许写入", async () => {
  const storage = new MemorySnapshotConnection();
  storage.strings.set("generation:session-a", "generation-1");

  const persisted = await mergeYjsSnapshotWithCas(storage, "snapshot:session-a", updateWith("message", "current"), 35, {
    key: "generation:session-a",
    generation: "generation-1",
  });

  expect(persisted).toBe(true);
  expect(storage.watchedKeys).toEqual([["snapshot:session-a", "generation:session-a"]]);
});

// generation fence 失配必须拒绝旧会话回写并撤销 WATCH。
test("过期 generation fence 拒绝写入并撤销 WATCH", async () => {
  const storage = new MemorySnapshotConnection();
  storage.strings.set("generation:session-a", "generation-2");

  const persisted = await mergeYjsSnapshotWithCas(storage, "snapshot:session-a", updateWith("message", "stale"), 36, {
    key: "generation:session-a",
    generation: "generation-1",
  });

  expect(persisted).toBe(false);
  expect(storage.writes).toEqual([]);
  expect(storage.unwatchCalls).toBe(1);
});

// 首次 CAS 冲突后必须重新 WATCH、读取并成功写入下一次合并结果。
test("CAS 冲突后重试并持久化", async () => {
  const storage = new MemorySnapshotConnection([null, [[null, "OK"]]]);

  const persisted = await mergeYjsSnapshotWithCas(storage, "snapshot:retry", updateWith("message", "retry"), 37);

  expect(persisted).toBe(true);
  expect(storage.watchedKeys).toHaveLength(2);
  expect(storage.writes).toHaveLength(1);
});

// 连续五次 CAS 冲突必须返回失败，不能产生不确定写入。
test("五次 CAS 冲突耗尽后返回失败", async () => {
  const storage = new MemorySnapshotConnection([null, null, null, null, null]);

  const persisted = await mergeYjsSnapshotWithCas(storage, "snapshot:conflict", updateWith("message", "lost"), 38);

  expect(persisted).toBe(false);
  expect(storage.watchedKeys).toHaveLength(5);
  expect(storage.writes).toEqual([]);
});

// WATCH 本身失败时不得尝试 UNWATCH，以免掩盖原始错误。
test("WATCH 失败直接传播错误且不撤销未建立的监听", async () => {
  const storage = new MemorySnapshotConnection();
  storage.failWatch = true;

  await expect(mergeYjsSnapshotWithCas(storage, "snapshot:error", updateWith("message", "x"), 39)).rejects.toThrow(
    "watch failed",
  );

  expect(storage.unwatchCalls).toBe(0);
});

// WATCH 后读取失败必须撤销 WATCH 并传播读取错误。
test("读取快照失败时撤销 WATCH", async () => {
  const storage = new MemorySnapshotConnection();
  storage.failRead = true;

  await expect(mergeYjsSnapshotWithCas(storage, "snapshot:error", updateWith("message", "x"), 40)).rejects.toThrow(
    "read failed",
  );

  expect(storage.unwatchCalls).toBe(1);
});

// EXEC 抛错时必须撤销 WATCH，避免专用连接残留事务状态。
test("EXEC 失败时撤销 WATCH", async () => {
  const storage = new MemorySnapshotConnection();
  storage.failExec = true;

  await expect(mergeYjsSnapshotWithCas(storage, "snapshot:error", updateWith("message", "x"), 41)).rejects.toThrow(
    "exec failed",
  );

  expect(storage.unwatchCalls).toBe(1);
});

// 清理快照必须保留无关根类型，同时删除目标 state 内容。
test("清理快照删除状态而保留无关数据", async () => {
  const storage = new MemorySnapshotConnection();
  const source = new Y.Doc();
  source.getMap("state").set("message", "remove");
  source.getMap("metadata").set("owner", "keep");
  const redis = new MemoryRedis(storage);
  const { target, snapshotKey } = prepareClearedTarget(storage, "clear", "gen-clear");
  storage.values.set(snapshotKey, Buffer.from(Y.encodeStateAsUpdate(source)));
  source.destroy();

  const persisted = await persistYjsClearedSnapshotWithCas(
    redis as never,
    target,
    updateWith("baseline", "also-remove"),
    clearState,
    42,
  );

  const restored = new Y.Doc();
  Y.applyUpdate(restored, new Uint8Array(storage.writes[0]!.value));
  expect(persisted).toBe(true);
  expect(restored.getMap("state").size).toBe(0);
  expect(restored.getMap("metadata").get("owner")).toBe("keep");
  expect(storage.writes[0]).toMatchObject({ seconds: 42 });
  restored.destroy();
});

// 清理 CAS 冲突后必须重新读取并清除冲突期间新写入的内容。
test("清理快照冲突重试不会带回并发内容", async () => {
  const storage = new MemorySnapshotConnection([null, [[null, "OK"]]]);
  const redis = new MemoryRedis(storage);
  const { target, snapshotKey } = prepareClearedTarget(storage, "clear-conflict", "gen-clear-conflict");
  storage.values.set(snapshotKey, Buffer.from(updateWith("old", "remove")));
  storage.onConflict = () => storage.values.set(snapshotKey, Buffer.from(updateWith("concurrent", "remove-too")));

  const persisted = await persistYjsClearedSnapshotWithCas(
    redis as never,
    target,
    updateWith("baseline", "remove-baseline"),
    clearState,
    43,
  );

  expect(persisted).toBe(true);
  expect(snapshotValue(storage.writes[0]!.value, "old")).toBeUndefined();
  expect(snapshotValue(storage.writes[0]!.value, "concurrent")).toBeUndefined();
});

// 清理路径也必须兼容旧版 base64 快照。
test("清理快照兼容旧版 base64 输入", async () => {
  const storage = new MemorySnapshotConnection();
  const redis = new MemoryRedis(storage);
  const { target, snapshotKey } = prepareClearedTarget(storage, "legacy-clear", "gen-legacy-clear");
  storage.values.set(snapshotKey, Buffer.from(Buffer.from(updateWith("old", "remove")).toString("base64")));

  const persisted = await persistYjsClearedSnapshotWithCas(
    redis as never,
    target,
    updateWith("baseline", "remove"),
    clearState,
    44,
  );

  expect(persisted).toBe(true);
  expect(snapshotValue(storage.writes[0]!.value, "old")).toBeUndefined();
});

// 清理回调抛错时必须撤销 WATCH 并断开临时 duplicate 连接。
test("清理回调失败时释放监听和临时连接", async () => {
  const storage = new MemorySnapshotConnection();
  const redis = new MemoryRedis(storage);
  const { target } = prepareClearedTarget(storage, "clear-error", "gen-clear-error");

  await expect(
    persistYjsClearedSnapshotWithCas(redis as never, target, updateWith("message", "x"), () => {
      throw new Error("clear failed");
    }),
  ).rejects.toThrow("clear failed");

  expect(storage.unwatchCalls).toBe(1);
  expect(storage.disconnectCalls).toBe(1);
});

// 清理路径冲突耗尽后仍必须断开临时连接且不写入。
test("清理快照冲突耗尽后断开临时连接", async () => {
  const storage = new MemorySnapshotConnection([null, null, null, null, null]);
  const redis = new MemoryRedis(storage);
  const { target } = prepareClearedTarget(storage, "clear-conflict-exhausted", "gen-clear-conflict-exhausted");

  const persisted = await persistYjsClearedSnapshotWithCas(
    redis as never,
    target,
    updateWith("message", "x"),
    clearState,
    45,
  );

  expect(persisted).toBe(false);
  expect(storage.writes).toEqual([]);
  expect(storage.disconnectCalls).toBe(1);
});
