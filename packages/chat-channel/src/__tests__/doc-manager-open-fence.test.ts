// packages/chat-channel/src/__tests__/doc-manager-open-fence.test.ts
// 快照水合窗口内的并发回归：open 在途时换代 / 关闭不得被旧世代 Doc 覆盖或“复活”。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
import type { SnapshotPersistConfig } from "../persist/snapshot-config";
import { initChatDocStructure, initSessionDocStructure } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { FakeRedis } from "./helpers/fake-redis";

const GENERATION = "gen_fence_test";
const SNAPSHOT_CONFIG: SnapshotPersistConfig = { intervalMs: 2_000, idleMs: 500, ttlSeconds: 604_800 };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function snapshotOf(init: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  init(doc);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function createManager(
  getRedis: () => FakeRedis | null,
  options?: { onYjsUpdate?: (docName: string, update: Uint8Array) => void },
): DocManager {
  const manager = new DocManager({
    getRedis: () => getRedis() as never,
    onYjsUpdate: options?.onYjsUpdate ?? null,
    onError: () => {},
    onLog: () => {},
  });
  manager.setSnapshotPersistConfigSource(() => SNAPSHOT_CONFIG);
  return manager;
}

describe("DocManager open fencing", () => {
  // 水合期间换代时，openChat 必须返回新世代 Doc，旧加载 Doc 及其 provider 必须销毁。
  test("openChat returns the replacement doc when replaceProjection lands during hydration", async () => {
    const rcsSessionId = "rcs_fence_chat_replace";
    const redis = new FakeRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, snapshotOf(initChatDocStructure));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);
    let activeRedis: FakeRedis | null = redis;
    const manager = createManager(() => activeRedis);

    const opening = manager.openChat(rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "chat snapshot read");

    // 让换代走内存路径，把断言集中在 DocManager 的 fence，而不是 Redis 代次 CAS。
    activeRedis = null;
    const replacement = await manager.replaceProjection(rcsSessionId, "ses_replacement");

    gate.resolve();
    const opened = await opening;

    expect(opened).toBe(replacement.chat);
    expect(opened.generation).toBe(replacement.chat.generation);
    expect(manager.getChat(rcsSessionId)).toBe(replacement.chat);
    // 旧加载 Doc 的 provider 已销毁：订阅连接与持久化连接都应断开。
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // 水合期间关闭时，openChat 必须拒绝且不得把 Doc 写回 map（关闭后复活）。
  test("openChat rejects and leaves the map empty when closeChat lands during hydration", async () => {
    const rcsSessionId = "rcs_fence_chat_close";
    const broadcasts: string[] = [];
    const redis = new FakeRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, snapshotOf(initChatDocStructure));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis, {
      onYjsUpdate: (docName) => broadcasts.push(docName),
    });

    const opening = manager.openChat(rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "chat snapshot read");
    await manager.closeChat(rcsSessionId);

    gate.resolve();
    await expect(opening).rejects.toThrow("chat doc was closed during open");
    expect(manager.getChat(rcsSessionId)).toBeUndefined();
    // 未注册广播的旧 Doc 不得再向连接泄漏更新。
    expect(broadcasts).toEqual([]);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
  });

  // openSession 与 openChat 共享同一时序约束：水合期间换代返回新 Session Doc。
  test("openSession returns the replacement doc when replaceProjection lands during hydration", async () => {
    const rcsSessionId = "rcs_fence_session_replace";
    const redis = new FakeRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, snapshotOf(initSessionDocStructure));
    const gate = deferred();
    redis.delayBuffer(`yjs:session:${rcsSessionId}:${GENERATION}`, gate.promise);
    let activeRedis: FakeRedis | null = redis;
    const manager = createManager(() => activeRedis);

    const opening = manager.openSession("user-1", "agent-1", rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "session snapshot read");

    activeRedis = null;
    const replacement = await manager.replaceProjection(rcsSessionId, "ses_replacement");

    gate.resolve();
    const opened = await opening;

    expect(opened).toBe(replacement.session);
    expect(opened.generation).toBe(replacement.session.generation);
    expect(manager.getSession(rcsSessionId)).toBe(replacement.session);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // GETBUFFER 返回前换代：应用后的旧快照不得被标记为 loaded，必须是 stale。
  test("redis provider reports stale hydration when generation changes before apply", async () => {
    const rcsSessionId = "rcs_fence_stale_hydration";
    const redis = new FakeRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, snapshotOf(initChatDocStructure));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);

    const ydoc = new Y.Doc();
    const provider = createRedisProvider(redis as never, `chat:${rcsSessionId}`, ydoc, {
      generation: GENERATION,
      snapshot: SNAPSHOT_CONFIG,
    });
    await waitFor(() => redis.bufferReads.length > 0, "snapshot read");
    redis.seedActiveGeneration(rcsSessionId, "gen_replaced_during_buffer_read");

    gate.resolve();
    const outcome = await provider.hydration;
    expect(outcome.status).toBe("stale");

    await provider.destroy();
    ydoc.destroy();
  });
});
