// packages/chat-channel/src/__tests__/snapshot-hydration.test.ts
// 真实恢复的两个阻断回归：
// A. Redis 快照异步加载：openChat / 握手历史源必须等水合完成，空结果不能提前被引导缓存；
// B. 恢复顺序：先应用快照再补结构，目标 clientID 任意大小都不能覆盖快照根类型。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { createLegacyChatHistorySource, readLegacyCommittedHistory } from "../channel/legacy-chat-history";
import type { SnapshotPersistConfig } from "../persist/snapshot-config";
import {
  appendEntryText,
  ensureEntry,
  getAgentStatus,
  getSessionInfo,
  getSessionsMap,
  initChatDocStructure,
  initSessionDocStructure,
  setEntryStatus,
} from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { loadChatDoc, loadSessionDoc, SnapshotHydrationError } from "../state/factory";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { decodeSyncFrame, type SyncFrame } from "../sync/protocol/frames";
import { scopeKey } from "../sync/protocol/identity";
import type { SyncFrameTransport } from "../sync/runtime/egress";
import { createSyncHostSession, type SyncHostSession } from "../sync/runtime/host-session";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import { FakeRedis } from "./helpers/fake-redis";

const NOW = 1_700_000_000_000;
const CLOCK: Clock = { now: () => NOW };
const SCOPE = { organizationId: "org-hydration", rcsSessionId: "rcs_hydration" };
const GENERATION = "gen_hydration_test";
const RUNTIME_CONFIG = { sealGraceMs: 2_000, retireGraceMs: 30_000, tickIntervalMs: 10 };
const tempRoots: string[] = [];

const SNAPSHOT_CONFIG: SnapshotPersistConfig = { intervalMs: 2_000, idleMs: 500, ttlSeconds: 604_800 };

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sync-hydration-"));
  tempRoots.push(root);
  return root;
}

function createDocManager(redis: FakeRedis): DocManager {
  const manager = new DocManager({ getRedis: () => redis as never, onError: () => {}, onLog: () => {} });
  manager.setSnapshotPersistConfigSource(() => SNAPSHOT_CONFIG);
  return manager;
}

function buildChatSnapshot(clientID: number, messages: readonly string[]): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  initChatDocStructure(doc);
  for (const [index, text] of messages.entries()) {
    const entryId = `turn-${index}:${index % 2 === 0 ? "user" : "assistant"}`;
    ensureEntry(doc, {
      entryId,
      turnId: `turn-${index}`,
      kind: "message",
      role: index % 2 === 0 ? "user" : "assistant",
    });
    appendEntryText(doc, entryId, "text:1", "text", text);
    setEntryStatus(doc, entryId, "completed");
  }
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function buildSessionSnapshot(clientID: number, count: number): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  initSessionDocStructure(doc);
  getSessionInfo(doc).set("sessionId", "ses_restored");
  getAgentStatus(doc).set("status", "ready");
  const sessions = getSessionsMap(doc);
  for (let index = 0; index < count; index += 1) {
    const session = new Y.Map<unknown>();
    session.set("sessionId", `sess-${index}`);
    session.set("title", `title-${index}`);
    sessions.set(`sess-${index}`, session);
  }
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function transportOf(): { transport: SyncFrameTransport; frames: SyncFrame[] } {
  const frames: SyncFrame[] = [];
  return {
    frames,
    transport: {
      send(bytes: Uint8Array): boolean {
        frames.push(decodeSyncFrame(bytes));
        return true;
      },
      bufferedAmount: () => 0,
      close(): void {},
    },
  };
}

function statelessHello(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: "HELLO",
      protocolVersion: 1,
      scope: { organizationId: "self-reported", rcsSessionId: "self-reported" },
      loadedDocs: [],
      stateful: false,
    }),
  );
}

const hosts: SyncHostSession[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Redis 快照水合时序（缺陷 A）", () => {
  // openChat 必须等 Redis 快照应用完成后才返回；并发调用共享同一在途 Doc。
  test("openChat 等待快照水合，返回后历史源读到完整时间线", async () => {
    const redis = new FakeRedis();
    redis.seedActiveGeneration(SCOPE.rcsSessionId, GENERATION);
    redis.seedSnapshot(
      `chat:${SCOPE.rcsSessionId}`,
      GENERATION,
      buildChatSnapshot(1, ["historic question", "historic answer"]),
    );
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${SCOPE.rcsSessionId}:${GENERATION}`, gate.promise);

    const manager = createDocManager(redis);
    let settled = false;
    const firstOpening = manager.openChat(SCOPE.rcsSessionId).then((doc) => {
      settled = true;
      return doc;
    });
    const secondOpening = manager.openChat(SCOPE.rcsSessionId);

    await waitFor(() => redis.bufferReads.length > 0, "redis snapshot read");
    expect(settled).toBe(false);

    gate.resolve();
    const [first, second] = await Promise.all([firstOpening, secondOpening]);
    expect(settled).toBe(true);
    expect(second).toBe(first);
    expect(first.hydration.status).toBe("loaded");
    expect(readLegacyCommittedHistory(first.ydoc).map((record) => record.value)).toEqual([
      "historic question",
      "historic answer",
    ]);
    await manager.closeChat(SCOPE.rcsSessionId);
  });

  // 确实没有快照时，水合结果明确为 empty；历史源返回空数组而不是挂起。
  test("无快照时水合完成并返回确定空结果", async () => {
    const redis = new FakeRedis();
    redis.seedActiveGeneration(SCOPE.rcsSessionId, GENERATION);
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${SCOPE.rcsSessionId}:${GENERATION}`, gate.promise);

    const manager = createDocManager(redis);
    const opening = manager.openChat(SCOPE.rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "redis snapshot read");
    gate.resolve();

    const doc = await opening;
    expect(doc.hydration.status).toBe("empty");
    expect(readLegacyCommittedHistory(doc.ydoc)).toEqual([]);
    await manager.closeChat(SCOPE.rcsSessionId);
  });

  // 快照读取失败必须显式拒绝打开；下一次打开可重试，且不会留下空的半初始化 Doc。
  test("快照加载失败时 openChat 拒绝，下一次打开重试成功", async () => {
    const redis = new FakeRedis();
    redis.seedActiveGeneration(SCOPE.rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${SCOPE.rcsSessionId}`, GENERATION, buildChatSnapshot(1, ["recovered"]));
    redis.failBufferOnce(`yjs:chat:${SCOPE.rcsSessionId}:${GENERATION}`, new Error("redis read failed"));

    const manager = createDocManager(redis);
    await expect(manager.openChat(SCOPE.rcsSessionId)).rejects.toBeInstanceOf(SnapshotHydrationError);
    expect(manager.getChat(SCOPE.rcsSessionId)).toBeUndefined();

    const doc = await manager.openChat(SCOPE.rcsSessionId);
    expect(readLegacyCommittedHistory(doc.ydoc).map((record) => record.value)).toEqual(["recovered"]);
    await manager.closeChat(SCOPE.rcsSessionId);
  });

  // 真实握手：HELLO 触发的历史读取必须等待 Redis 快照；水合前不产生 MANIFEST，也不会缓存空基线。
  test("握手导入等待 Redis 快照，水合前不产生 MANIFEST", async () => {
    const redis = new FakeRedis();
    redis.seedActiveGeneration(SCOPE.rcsSessionId, GENERATION);
    redis.seedSnapshot(
      `chat:${SCOPE.rcsSessionId}`,
      GENERATION,
      buildChatSnapshot(1, ["redis legacy question", "redis legacy answer"]),
    );
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${SCOPE.rcsSessionId}:${GENERATION}`, gate.promise);

    const manager = createDocManager(redis);
    const { transport, frames } = transportOf();
    const store = new MemoryProjectionStore({
      clock: CLOCK,
      digest: sha256Digest,
      capacity: DEFAULT_SYNC_CAPACITY,
      lifecycle: { sealGraceMs: RUNTIME_CONFIG.sealGraceMs, retireGraceMs: RUNTIME_CONFIG.retireGraceMs },
    });
    const source = createLegacyChatHistorySource({
      docs: manager,
      rcsSessionId: SCOPE.rcsSessionId,
      acpSessionId: "ses_legacy",
    });
    const session = await createSyncHostSession({
      scope: SCOPE,
      runtimeConfig: { ...RUNTIME_CONFIG, spoolRootDir: join(tempRoot(), "spool") },
      transport,
      clock: CLOCK,
      digest: sha256Digest,
      random: deterministicRandomSource("snapshot-hydration-handshake"),
      store,
      owner: "test-owner",
      historySource: source,
      onError: () => {},
    });
    hosts.push(session);

    const hello = session.onInboundBytes(statelessHello());
    await waitFor(() => redis.bufferReads.length > 0, "redis snapshot read in handshake");
    expect(frames.find((frame) => frame.type === "MANIFEST")).toBeUndefined();

    gate.resolve();
    await hello;
    const manifest = frames.find(
      (frame): frame is Extract<SyncFrame, { type: "MANIFEST" }> => frame.type === "MANIFEST",
    );
    expect(manifest).toBeDefined();
    if (!manifest) throw new Error("expected MANIFEST after hydration");

    const generation = await store.readGeneration(scopeKey(SCOPE), manifest.generation);
    expect(generation?.state).toBe("committed");
    expect(generation?.importEndOrdinal ?? 0).toBeGreaterThan(0);
    expect(generation?.entryRefs.contentDocIds.length).toBeGreaterThan(0);

    await manager.closeChat(SCOPE.rcsSessionId);
  });
});

describe("快照恢复顺序（缺陷 B）", () => {
  // Chat Doc：任意目标 clientID 下，20 条历史都必须完整恢复。
  test("Chat Doc 在 clientID 0/2/10/1000 下恢复 20 条历史", async () => {
    const expected = Array.from({ length: 20 }, (_, index) => `message-${index}`);
    const snapshot = buildChatSnapshot(1, expected);

    for (const clientID of [0, 2, 10, 1000]) {
      const redis = new FakeRedis();
      redis.seedActiveGeneration(SCOPE.rcsSessionId, GENERATION);
      redis.seedSnapshot(`chat:${SCOPE.rcsSessionId}`, GENERATION, snapshot);

      const doc = await loadChatDoc(SCOPE.rcsSessionId, redis as never, GENERATION, SNAPSHOT_CONFIG, { clientID });
      expect(readLegacyCommittedHistory(doc.ydoc).map((record) => record.value)).toEqual(expected);
      expect(doc.hydration.status).toBe("loaded");
      await doc.destroy();
    }
  });

  // Session Doc：任意目标 clientID 下，20 条会话摘要与 session/agent 根类型都必须完整恢复。
  test("Session Doc 在 clientID 0/2/10/1000 下恢复 20 条会话摘要", async () => {
    const snapshot = buildSessionSnapshot(1, 20);

    for (const clientID of [0, 2, 10, 1000]) {
      const redis = new FakeRedis();
      redis.seedActiveGeneration(SCOPE.rcsSessionId, GENERATION);
      redis.seedSnapshot(`session:${SCOPE.rcsSessionId}`, GENERATION, snapshot);

      const doc = await loadSessionDoc(SCOPE.rcsSessionId, redis as never, GENERATION, SNAPSHOT_CONFIG, { clientID });
      expect(doc.hydration.status).toBe("loaded");
      expect(getSessionInfo(doc.ydoc).get("sessionId")).toBe("ses_restored");
      expect(getAgentStatus(doc.ydoc).get("status")).toBe("ready");
      const sessions = getSessionsMap(doc.ydoc);
      expect(sessions.size).toBe(20);
      expect((sessions.get("sess-19") as Y.Map<unknown>).get("title")).toBe("title-19");
      await doc.destroy();
    }
  });
});
