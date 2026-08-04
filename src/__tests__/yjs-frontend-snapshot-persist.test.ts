// src/__tests__/yjs-frontend-snapshot-persist.test.ts
// 会话切换前的 Redis CAS 快照持久化（原 yjs-frontend-session-transition.test.ts 中
// persistClearedSessionSnapshot 相关断言；SessionTransition 守卫语义已迁入
// packages/chat-channel 的 SessionChannel，由包内 session-channel-action.test.ts 覆盖）。
// persistClearedSessionSnapshot 现由 Chat 域桥接层（chat-channel-bootstrap）提供。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { persistClearedSessionSnapshot } from "../services/chat-channel-bootstrap";

class SnapshotPersistenceDouble {
  disconnected = false;
  watchCalls = 0;

  constructor(private readonly redis: SnapshotRedisDouble) {}

  watch(): Promise<"OK"> {
    this.watchCalls += 1;
    return Promise.resolve("OK");
  }

  unwatch(): Promise<"OK"> {
    return Promise.resolve("OK");
  }

  getBuffer(): Promise<Buffer | null> {
    return Promise.resolve(this.redis.stored ? Buffer.from(this.redis.stored) : null);
  }

  multi(): { set(key: string, value: Buffer): { exec(): Promise<unknown> }; exec(): Promise<unknown> } {
    let write: { key: string; value: Buffer } | null = null;
    const transaction = {
      set: (key: string, value: Buffer) => {
        write = { key, value };
        return transaction;
      },
      exec: async () => {
        if (this.redis.failure) throw this.redis.failure;
        if (write) {
          this.redis.writes.push({ key: write.key, value: Buffer.from(write.value) });
          this.redis.stored = Buffer.from(write.value);
        }
        return [[null, "OK"]];
      },
    };
    return transaction;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class SnapshotRedisDouble {
  readonly writes: Array<{ key: string; value: Buffer }> = [];
  readonly persistences: SnapshotPersistenceDouble[] = [];
  stored: Buffer | null = null;

  constructor(
    readonly failure?: Error,
    initialSnapshot: Buffer | null = null,
  ) {
    this.stored = initialSnapshot ? Buffer.from(initialSnapshot) : null;
  }

  duplicate(): SnapshotPersistenceDouble {
    const persistence = new SnapshotPersistenceDouble(this);
    this.persistences.push(persistence);
    return persistence;
  }
}

describe("persistClearedSessionSnapshot", () => {
  // Redis 快照必须使用原始 Buffer，且清空后的状态能由 Y.applyUpdate 恢复（新 schema 骨架）。
  test("persists the cleared session snapshot as a recoverable Buffer", async () => {
    const source = new Y.Doc();
    source.getMap("root").set("session", new Y.Map());
    source.getMap("root").set("agent", new Y.Map());
    const redis = new SnapshotRedisDouble();

    await persistClearedSessionSnapshot(redis as never, "yjs:session:rcs-1", source);

    expect(redis.writes).toHaveLength(1);
    expect(redis.writes[0]?.key).toBe("yjs:session:rcs-1");
    expect(redis.writes[0]?.value).toBeInstanceOf(Buffer);
    expect(redis.persistences[0]?.watchCalls).toBe(1);
    expect(redis.persistences[0]?.disconnected).toBe(true);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, redis.writes[0]?.value ?? Buffer.alloc(0));
    expect((restored.getMap("root").get("session") as Y.Map<unknown>).size).toBe(0);
    expect((restored.getMap("root").get("agent") as Y.Map<unknown>).size).toBe(0);

    source.destroy();
    restored.destroy();
  });

  // 清空快照必须删除 Redis 中清空者未见的并发会话内容，且不能改动真实文档。
  test("clears unseen concurrent Redis content without mutating the source document", async () => {
    const source = new Y.Doc();
    const current = new Y.Doc();
    const restored = new Y.Doc();
    const sourceRoot = source.getMap("root");
    sourceRoot.set("session", new Y.Map());
    const sessionMap = sourceRoot.get("session") as Y.Map<unknown>;
    sessionMap.set("sessionId", "ses_old");
    sourceRoot.set("pendingPermissions", new Y.Map());

    Y.applyUpdate(current, Y.encodeStateAsUpdate(source));
    const currentRoot = current.getMap("root");
    (currentRoot.get("session") as Y.Map<unknown>).set("sessionId", "ses_concurrent");
    (currentRoot.get("pendingPermissions") as Y.Map<unknown>).set("p1", new Y.Map());
    const redis = new SnapshotRedisDouble(undefined, Buffer.from(Y.encodeStateAsUpdate(current)));

    await persistClearedSessionSnapshot(redis as never, "yjs:session:rcs-1", source);

    Y.applyUpdate(restored, redis.writes[0]?.value ?? Buffer.alloc(0));
    const restoredRoot = restored.getMap("root");
    expect((restoredRoot.get("session") as Y.Map<unknown>).toJSON()).toEqual({});
    expect((restoredRoot.get("pendingPermissions") as Y.Map<unknown>).size).toBe(0);
    expect((sourceRoot.get("session") as Y.Map<unknown>).get("sessionId")).toBe("ses_old");

    source.destroy();
    current.destroy();
    restored.destroy();
  });

  // Redis set 拒绝必须让快照准备失败，由会话切换逻辑阻止真实 clear。
  test("propagates Redis set rejection from snapshot preparation", async () => {
    const source = new Y.Doc();

    await expect(
      persistClearedSessionSnapshot(
        new SnapshotRedisDouble(new Error("Redis unavailable")) as never,
        "yjs:session:rcs-1",
        source,
      ),
    ).rejects.toThrow("Redis unavailable");

    source.destroy();
  });
});
