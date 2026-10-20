// packages/chat-channel/src/channel/sync-connection.test.ts
// 连接级同步 runtime 的创建语义：并发首帧只 attach 一次，失败后允许下一帧重试。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createChatDoc } from "../state/factory";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest, systemClock } from "../sync/clock";
import { encodeSyncFrame, SYNC_PROTOCOL_VERSION } from "../sync/protocol/frames";
import type { SyncScope } from "../sync/protocol/identity";
import { SyncStoreRegistry } from "../sync/runtime/store-registry";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { ProjectionStore } from "../sync/store/types";
import { createClient, createWs } from "./connection-test-helpers";
import type { SyncConnection } from "./connection-types";
import { attachGatewaySyncConnection, ensureGatewaySyncConnection } from "./sync-connection";

function fakeSyncConnection(): SyncConnection {
  return {
    onInboundBytes: async () => {},
    acceptNormalizedEvent: () => {},
    acceptUserMessage: () => {},
    dispose: () => {},
  };
}

describe("ensureGatewaySyncConnection", () => {
  // 两个并发首帧共享同一在途 attach：只创建一份 runtime，两个调用拿到同一实例。
  test("shares one in-flight attach between concurrent first frames", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    let attachCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attach = async (): Promise<SyncConnection> => {
      attachCalls += 1;
      await gate;
      return connection;
    };

    const first = ensureGatewaySyncConnection(entry, attach);
    const second = ensureGatewaySyncConnection(entry, attach);
    expect(attachCalls).toBe(1);

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(connection);
    expect(secondResult).toBe(connection);
    expect(entry.syncConnection).toBe(connection);
  });

  // attach 初始化失败（返回 undefined）后清空在途登记，下一帧可以重新创建。
  test("retries attach after an initialization failure", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    let attempts = 0;
    const attach = async (): Promise<SyncConnection | undefined> => {
      attempts += 1;
      return attempts === 1 ? undefined : connection;
    };

    expect(await ensureGatewaySyncConnection(entry, attach)).toBeUndefined();
    expect(entry.syncConnection).toBeUndefined();
    expect(await ensureGatewaySyncConnection(entry, attach)).toBe(connection);
    expect(attempts).toBe(2);
  });

  // attach 抛错同样清理登记，不会被后续帧永久复用为失败的 Promise。
  test("clears the in-flight entry when attach rejects", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    let attempts = 0;
    const attach = async (): Promise<SyncConnection> => {
      attempts += 1;
      if (attempts === 1) throw new Error("attach failed");
      return connection;
    };

    await expect(ensureGatewaySyncConnection(entry, attach)).rejects.toThrow("attach failed");
    expect(await ensureGatewaySyncConnection(entry, attach)).toBe(connection);
    expect(attempts).toBe(2);
  });

  // 已创建的 runtime 直接复用，不再进入 attach（例如首帧已建立后其他帧到达）。
  test("reuses an existing connection without attaching again", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    entry.syncConnection = connection;
    let attachCalls = 0;

    const result = await ensureGatewaySyncConnection(entry, async () => {
      attachCalls += 1;
      return fakeSyncConnection();
    });

    expect(result).toBe(connection);
    expect(attachCalls).toBe(0);
  });

  // attach 期间连接已关闭：落定的 runtime 必须立即 dispose，且不得写回 entry 造成 store 泄漏。
  test("closes and disposes when the entry closes during attach", async () => {
    const entry = createClient();
    let disposed = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connection = fakeSyncConnection();
    connection.dispose = () => {
      disposed += 1;
    };
    const pending = ensureGatewaySyncConnection(entry, async () => {
      await gate;
      return connection;
    });
    entry.syncClosed = true;
    release();

    expect(await pending).toBeUndefined();
    expect(disposed).toBe(1);
    expect(entry.syncConnection).toBeUndefined();
  });

  // 绑定必须走 openChat 的权威代次复核：内存里的旧 Doc 不得让新连接落到旧 store。
  test("binds the active generation from openChat instead of the cached doc", async () => {
    const stale = createChatDoc("rcs-bind", null, "g-stale");
    const fresh = createChatDoc("rcs-bind", null, "g-active");
    let current = stale;
    const docs = {
      getChat: () => current,
      openChat: async () => {
        current = fresh;
        return fresh;
      },
    };
    class RecordingRegistry extends SyncStoreRegistry {
      readonly bindings: Array<string | undefined> = [];
      override acquire(scope: SyncScope, createStore: () => ProjectionStore, binding?: string) {
        this.bindings.push(binding);
        return super.acquire(scope, createStore, binding);
      }
    }
    const registry = new RecordingRegistry();
    const ws = createWs();
    const errors: unknown[] = [];
    const connection = await attachGatewaySyncConnection(
      ws,
      { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
      "org-1",
      "rcs-bind",
      "owner",
      (_message, error) => errors.push(error),
      { storeRegistry: registry },
      { acpSessionId: "ses-active", docs },
    );
    expect(errors).toEqual([]);
    expect(connection).toBeDefined();
    expect(registry.bindings).toEqual(["g-active"]);
    connection?.dispose();
    stale.ydoc.destroy();
    fresh.ydoc.destroy();
  });

  // 绑定复核失败必须走可重试关闭码，不能进入不可恢复的 1011 终态。
  test("closes with retryable code when binding resolution fails", async () => {
    const ws = createWs();
    const docs = {
      getChat: () => undefined,
      openChat: async () => {
        throw new Error("redis unavailable");
      },
    };
    const connection = await attachGatewaySyncConnection(
      ws,
      { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
      "org-1",
      "rcs-bind-fail",
      "owner",
      () => {},
      {},
      { acpSessionId: "ses-active", docs },
    );
    expect(connection).toBeUndefined();
    expect(ws.closed).toEqual([[1012, "sync init retry"]]);
  });
});

/** 从已提交状态重建内容 Doc：只读已提交字节，避免用写者内存状态自证。 */
function committedTexts(store: MemoryProjectionStore): string[] {
  const snapshot = store.exportCommittedState();
  const decoder = new TextDecoder();
  const texts: string[] = [];
  for (const doc of snapshot.docs) {
    if (doc.kind !== "content") continue;
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, doc.baseSnapshot);
    for (const update of snapshot.updates) {
      if (update.docId === doc.docId) Y.applyUpdate(ydoc, update.bytes);
    }
    const records = ydoc.getMap<unknown>("root").get("records");
    if (records instanceof Y.Array) {
      for (const record of records.toArray() as Array<{ payload: Uint8Array }>) {
        texts.push(decoder.decode(record.payload));
      }
    }
    ydoc.destroy();
  }
  return texts;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("同步用户消息的代次复核", () => {
  // 跨进程换代后旧 store 不再接收用户消息：写入前复核 Redis，失败时以可重试码关闭连接。
  test("drops a user message and invalidates the connection when the projection is stale", async () => {
    const rcsSessionId = "rcs-sync-stale-message";
    const chat = createChatDoc(rcsSessionId, null, "gen-old");
    let current = true;
    const store = new MemoryProjectionStore({
      clock: systemClock,
      digest: sha256Digest,
      capacity: DEFAULT_SYNC_CAPACITY,
      lifecycle: { sealGraceMs: 2_000, retireGraceMs: 30_000 },
    });
    const docs = {
      getChat: () => ({ ydoc: chat.ydoc, generation: chat.generation }),
      openChat: async () => ({ ydoc: chat.ydoc, generation: chat.generation }),
      isGenerationCurrent: async () => current,
    };
    const ws = createWs();
    const connection = await attachGatewaySyncConnection(
      ws,
      { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
      "org-1",
      rcsSessionId,
      "owner",
      () => {},
      {
        store,
        clock: systemClock,
        random: deterministicRandomSource("sync-generation-guard"),
        digest: sha256Digest,
        tickIntervalMs: 1_000,
      },
      { acpSessionId: null, docs },
    );
    await connection!.onInboundBytes(
      encodeSyncFrame({
        type: "HELLO",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        scope: { organizationId: "org-1", rcsSessionId },
        loadedDocs: [],
        stateful: false,
      }),
    );

    current = false;
    connection!.acceptUserMessage("turn-stale", "stale text");
    await waitFor(() => ws.closed.length > 0, "stale connection invalidation");

    // 首次关闭是让客户端重建的可重试码；dispose 对已关闭 socket 的再次 close 在真实适配器上是 no-op。
    expect(ws.closed[0]).toEqual([1012, "projection replaced"]);
    expect(committedTexts(store)).toEqual([]);
    connection!.dispose();
    chat.ydoc.destroy();
  });

  // 代次仍为当前时用户消息照常落库：复核不能把正常写入一并挡掉。
  test("commits the user message when the projection generation is current", async () => {
    const rcsSessionId = "rcs-sync-live-message";
    const chat = createChatDoc(rcsSessionId, null, "gen-live");
    const store = new MemoryProjectionStore({
      clock: systemClock,
      digest: sha256Digest,
      capacity: DEFAULT_SYNC_CAPACITY,
      lifecycle: { sealGraceMs: 2_000, retireGraceMs: 30_000 },
    });
    const docs = {
      getChat: () => ({ ydoc: chat.ydoc, generation: chat.generation }),
      openChat: async () => ({ ydoc: chat.ydoc, generation: chat.generation }),
      isGenerationCurrent: async () => true,
    };
    const ws = createWs();
    const connection = await attachGatewaySyncConnection(
      ws,
      { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
      "org-1",
      rcsSessionId,
      "owner",
      () => {},
      {
        store,
        clock: systemClock,
        random: deterministicRandomSource("sync-generation-current"),
        digest: sha256Digest,
        tickIntervalMs: 1_000,
      },
      { acpSessionId: null, docs },
    );
    await connection!.onInboundBytes(
      encodeSyncFrame({
        type: "HELLO",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        scope: { organizationId: "org-1", rcsSessionId },
        loadedDocs: [],
        stateful: false,
      }),
    );

    connection!.acceptUserMessage("turn-live", "live text");
    await waitFor(() => committedTexts(store).includes("live text"), "live user message commit");

    expect(committedTexts(store)).toEqual(["live text"]);
    expect(ws.closed).toEqual([]);
    connection!.dispose();
    chat.ydoc.destroy();
  });
});
