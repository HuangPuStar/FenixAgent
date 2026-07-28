import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { persistClearedSessionSnapshot } from "../transport/relay/yjs-frontend";
import {
  InvalidSessionIdError,
  SessionTransition,
  type SessionTransitionDependencies,
  type SessionTransitionEntry,
} from "../transport/relay/yjs-frontend/session-transition";

const entry = (overrides: Partial<SessionTransitionEntry> = {}): SessionTransitionEntry => ({
  userId: "user-1",
  agentId: "agent-1",
  rcsSessionId: "rcs-1",
  acpSessionId: null,
  agentStatusReceived: true,
  ...overrides,
});

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

function createDependencies() {
  const calls: string[] = [];
  const events: Array<{ rcsSessionId: string; type: string; payload: Record<string, unknown> }> = [];
  const dependencies: SessionTransitionDependencies = {
    openSession: async () => {
      calls.push("open");
    },
    clearSessionDocContent: () => {
      calls.push("clear");
    },
    prepareClearSessionSnapshot: async () => {
      calls.push("prepare");
    },
    processACP: (rcsSessionId, event) => {
      calls.push(`process:${event.type}`);
      events.push({ rcsSessionId, ...event });
    },
    reportError: (message) => {
      calls.push(`error:${message}`);
    },
  };

  return { calls, dependencies, events };
}

describe("SessionTransition", () => {
  // Redis 快照必须使用原始 Buffer，且清空后的状态能由 Y.applyUpdate 恢复。
  test("persists the cleared session snapshot as a recoverable Buffer", async () => {
    const source = new Y.Doc();
    const messages = source.getArray("messages");
    messages.push(["message to clear"]);
    source.getMap("meta").set("status", "streaming");
    const redis = new SnapshotRedisDouble();

    await persistClearedSessionSnapshot(redis as never, "yjs:session:rcs-1", source);

    expect(redis.writes).toHaveLength(1);
    expect(redis.writes[0]?.key).toBe("yjs:session:rcs-1");
    expect(redis.writes[0]?.value).toBeInstanceOf(Buffer);
    expect(redis.persistences[0]?.watchCalls).toBe(1);
    expect(redis.persistences[0]?.disconnected).toBe(true);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, redis.writes[0]?.value ?? Buffer.alloc(0));
    expect(restored.getArray("messages").toArray()).toEqual([]);
    expect(restored.getMap("meta").get("status")).toBe("idle");

    source.destroy();
    restored.destroy();
  });

  // 清空快照必须删除 Redis 中清空者未见的并发会话内容，且不能改动真实文档。
  test("clears unseen concurrent Redis content without mutating the source document", async () => {
    const source = new Y.Doc();
    const current = new Y.Doc();
    const restored = new Y.Doc();
    source.getArray("messages").push(["old message"]);
    source.getArray("structuredMessages").push([{ id: "old" }]);
    source.getMap("streaming").set("old", true);
    source.getMap("tools").set("old", { status: "running" });
    source.getArray("artifacts").push([{ id: "old" }]);
    source.getMap("meta").set("status", "streaming");
    source.getMap("meta").set("loading", "old request");

    Y.applyUpdate(current, Y.encodeStateAsUpdate(source));
    current.getArray("messages").push(["concurrent message"]);
    current.getArray("structuredMessages").push([{ id: "concurrent" }]);
    current.getMap("streaming").set("concurrent", true);
    current.getMap("tools").set("concurrent", { status: "running" });
    current.getArray("artifacts").push([{ id: "concurrent" }]);
    const redis = new SnapshotRedisDouble(undefined, Buffer.from(Y.encodeStateAsUpdate(current)));

    await persistClearedSessionSnapshot(redis as never, "yjs:session:rcs-1", source);

    Y.applyUpdate(restored, redis.writes[0]?.value ?? Buffer.alloc(0));
    expect(restored.getArray("messages").toArray()).toEqual([]);
    expect(restored.getArray("structuredMessages").toArray()).toEqual([]);
    expect(restored.getMap("streaming").toJSON()).toEqual({});
    expect(restored.getMap("tools").toJSON()).toEqual({});
    expect(restored.getArray("artifacts").toArray()).toEqual([]);
    expect(restored.getMap("meta").toJSON()).toMatchObject({ status: "idle", loading: null });
    expect(source.getArray("messages").toArray()).toEqual(["old message"]);

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

  // 同一 ACP session 的 load 不应清空文档、持久化快照或转发给 agent
  test("skips same-session load", async () => {
    const { calls, dependencies } = createDependencies();
    const transition = new SessionTransition(dependencies);
    const connection = entry({ acpSessionId: "session-1" });

    const shouldForward = await transition.beforeForward(connection, {
      action: "load_session",
      sessionId: "session-1",
    });

    expect(shouldForward).toBe(false);
    expect(connection.acpSessionId).toBe("session-1");
    expect(calls).toEqual([]);
  });

  // 切换到不同 ACP session 时必须先持久化克隆清空快照，再清空真实文档并允许 relay 转发
  test("waits for snapshot preparation before clearing a different loaded session", async () => {
    const { calls, dependencies } = createDependencies();
    let resolvePrepare!: () => void;
    const prepared = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    dependencies.prepareClearSessionSnapshot = async () => {
      calls.push("prepare");
      await prepared;
    };
    const transition = new SessionTransition(dependencies);
    const connection = entry({ acpSessionId: "session-old" });
    let completed = false;

    const beforeForward = transition
      .beforeForward(connection, { action: "load_session", sessionId: "session-new" })
      .then((shouldForward) => {
        completed = true;
        return shouldForward;
      });

    expect(connection.acpSessionId).toBe("session-old");
    expect(calls).toEqual(["prepare"]);
    expect(completed).toBe(false);

    resolvePrepare();

    expect(await beforeForward).toBe(true);
    expect(completed).toBe(true);
    expect(calls).toEqual(["prepare", "clear"]);
    expect(connection.acpSessionId).toBe("session-new");
  });

  // 快照持久化失败时必须保留真实文档和旧 ACP session ID。
  test("does not clear or change the loaded session when snapshot preparation rejects", async () => {
    const { calls, dependencies } = createDependencies();
    dependencies.prepareClearSessionSnapshot = async () => {
      calls.push("prepare");
      throw new Error("Redis unavailable");
    };
    const transition = new SessionTransition(dependencies);
    const connection = entry({ acpSessionId: "session-old" });

    await expect(
      transition.beforeForward(connection, { action: "load_session", sessionId: "session-new" }),
    ).rejects.toThrow("Redis unavailable");

    expect(calls).toEqual(["prepare"]);
    expect(connection.acpSessionId).toBe("session-old");
  });

  // create_session 必须先打开 Session Doc、持久化克隆清空快照，再清空真实文档
  test("opens, snapshots, and then clears the session doc for create", async () => {
    const { calls, dependencies } = createDependencies();
    const transition = new SessionTransition(dependencies);

    const shouldForward = await transition.beforeForward(entry(), { action: "create_session" });

    expect(shouldForward).toBe(true);
    expect(calls).toEqual(["open", "prepare", "clear"]);
  });

  // agent status 尚未到达时 list_sessions 必须跳过转发
  test("gates list_sessions until agent status arrives", async () => {
    const { calls, dependencies } = createDependencies();
    const transition = new SessionTransition(dependencies);

    const shouldForward = await transition.beforeForward(entry({ agentStatusReceived: false }), {
      action: "list_sessions",
    });

    expect(shouldForward).toBe(false);
    expect(calls).toEqual([]);
  });

  // send_prompt 只拼接 text block，并在 relay 转发前写入 user_message_chunk
  test("prewrites text prompt blocks and skips non-text blocks", async () => {
    const { calls, dependencies, events } = createDependencies();
    const transition = new SessionTransition(dependencies);

    const shouldForward = await transition.beforeForward(entry(), {
      action: "send_prompt",
      content: [
        { type: "image", url: "ignored" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "resource", uri: "ignored" },
      ],
    });
    const shouldForwardNonText = await transition.beforeForward(entry(), {
      action: "send_prompt",
      content: [{ type: "image", url: "ignored" }],
    });

    expect(shouldForward).toBe(true);
    expect(shouldForwardNonText).toBe(true);
    expect(calls).toEqual(["open", "process:user_message_chunk"]);
    expect(events).toEqual([
      {
        rcsSessionId: "rcs-1",
        type: "user_message_chunk",
        payload: { content: { type: "text", text: "first\nsecond" } },
      },
    ]);
  });

  // cancel 只有 relay 已成功转发后才清除 loading 状态
  test("clears loading after cancel is forwarded", async () => {
    const { calls, dependencies, events } = createDependencies();
    const transition = new SessionTransition(dependencies);
    const connection = entry({ acpSessionId: "session-1" });

    const shouldForward = await transition.beforeForward(connection, { action: "cancel" });
    calls.push("forward");
    transition.afterForward(connection, { action: "cancel" });

    expect(shouldForward).toBe(true);
    expect(calls).toEqual(["forward", "process:agent_message_complete"]);
    expect(events).toEqual([{ rcsSessionId: "rcs-1", type: "agent_message_complete", payload: {} }]);
  });

  // 空或非字符串的 load_session ID 必须保留给主处理器转换为既有错误帧
  test("rejects an invalid loaded session ID", async () => {
    const { dependencies } = createDependencies();
    const transition = new SessionTransition(dependencies);

    expect(transition.beforeForward(entry(), { action: "load_session", sessionId: "" })).rejects.toBeInstanceOf(
      InvalidSessionIdError,
    );
  });
});
