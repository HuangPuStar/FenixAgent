// packages/chat-channel/src/__tests__/doc-manager-open-fence.test.ts
// 投影生命周期并发回归：区分 close、replace 成功、replace 失败三类事件。
//
// 覆盖生产 Redis active generation 路径：慢水合期间换代、publish await 窗口内 open/close、
// CAS 失败误伤、closeAll 与在途 open、GETBUFFER 后 apply 前换代。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { readLegacyCommittedHistory } from "../channel/legacy-chat-history";
import { createRedisProvider } from "../persist/redis";
import type { SnapshotPersistConfig } from "../persist/snapshot-config";
import {
  appendEntryText,
  ensureEntry,
  initChatDocStructure,
  initSessionDocStructure,
  setEntryStatus,
} from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { FakeRedis } from "./helpers/fake-redis";

const GENERATION = "gen_fence_old";
const REPLACED_EXTERNALLY = "gen_fence_external";
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

/** FakeRedis 默认 EVAL 返回 0；生产 CAS 需要真正比较并推进 active generation。 */
class ProdRedis extends FakeRedis {
  override async eval(_script?: unknown, numKeys?: number, ...args: unknown[]): Promise<number> {
    if (numKeys !== 1) return 0;
    const [key, expected, next] = args as [string, string, string];
    if ((await this.get(key)) !== expected) return 0;
    await this.set(key, next);
    return 1;
  }
}

/** 让 publishActiveGeneration 停在 await 窗口，用于覆盖 open / close 与 publish 的竞争。 */
class GatedEvalRedis extends ProdRedis {
  evalStarted = false;
  private readonly gate = deferred();
  private readonly started = deferred();

  override async eval(script?: unknown, numKeys?: number, ...args: unknown[]): Promise<number> {
    if (numKeys === 1) {
      this.evalStarted = true;
      this.started.resolve();
      await this.gate.promise;
    }
    return super.eval(script, numKeys, ...args);
  }

  releaseEval(): void {
    this.gate.resolve();
  }
}

function snapshotOf(init: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  init(doc);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function chatSnapshotWithText(text: string): Uint8Array {
  return snapshotOf((doc) => {
    initChatDocStructure(doc);
    ensureEntry(doc, { entryId: "turn-1:user", turnId: "turn-1", kind: "message", role: "user" });
    appendEntryText(doc, "turn-1:user", "text:1", "text", text);
    setEntryStatus(doc, "turn-1:user", "completed");
  });
}

function historyValues(ydoc: Y.Doc): string[] {
  return readLegacyCommittedHistory(ydoc).map((record) => record.value);
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

describe("DocManager 投影生命周期栅栏", () => {
  // 生产 Redis 换代在水合期间提交：openChat 必须返回 map 中的新世代 Doc，不得因 stale 拒绝。
  test("生产 Redis 换代在水合期间提交时 openChat 返回新世代 Doc", async () => {
    const rcsSessionId = "rcs_fence_chat_replace";
    const broadcasts: string[] = [];
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const opening = manager.openChat(rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "chat snapshot read");
    const replacement = await manager.replaceProjection(rcsSessionId, "ses_replacement");

    gate.resolve();
    const opened = await opening;

    expect(opened).toBe(replacement.chat);
    expect(opened.generation).toBe(replacement.generation);
    expect(manager.getChat(rcsSessionId)).toBe(replacement.chat);
    // 旧快照内容不得作为新投影的历史返回。
    expect(historyValues(opened.ydoc)).toEqual([]);
    // 旧加载 Doc 的 provider 已销毁：持久化与订阅连接都断开。
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    // 旧 Doc 从未注册广播，换代提交本身也不产生聊天更新。
    expect(broadcasts).toEqual([]);
    await manager.closeAll();
  });

  // Session 共享同一语义：换代在水合期间提交时 openSession 返回新世代 Doc。
  test("生产 Redis 换代在水合期间提交时 openSession 返回新世代 Doc", async () => {
    const rcsSessionId = "rcs_fence_session_replace";
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, snapshotOf(initSessionDocStructure));
    const gate = deferred();
    redis.delayBuffer(`yjs:session:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis);

    const opening = manager.openSession("user-1", "agent-1", rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "session snapshot read");
    const replacement = await manager.replaceProjection(rcsSessionId, "ses_replacement");

    gate.resolve();
    const opened = await opening;

    expect(opened).toBe(replacement.session);
    expect(opened.generation).toBe(replacement.generation);
    expect(manager.getSession(rcsSessionId)).toBe(replacement.session);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // open 的加载在 publish await 窗口内完成：不得把旧世代写入 map，换代提交后返回新世代。
  test("openChat 在 replace 的 publish await 窗口内完成时只返回新世代 Doc", async () => {
    const rcsSessionId = "rcs_fence_publish_window_open";
    const broadcasts: string[] = [];
    const redis = new GatedEvalRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const replacementPromise = manager.replaceProjection(rcsSessionId, "ses_replacement");
    await waitFor(() => redis.evalStarted, "publishActiveGeneration eval");

    const persistenceCountBeforeOpen = redis.persistences.length;
    const subscriberCountBeforeOpen = redis.subscribers.length;
    let openSettled = false;
    const opening = manager.openChat(rcsSessionId).then(
      (doc) => {
        openSettled = true;
        return doc;
      },
      (error) => {
        openSettled = true;
        throw error;
      },
    );

    // 加载必须完成并停在安装前；publish 未落定前不得写 map / 注册广播。
    await waitFor(() => redis.persistences.length > persistenceCountBeforeOpen, "open provider created");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openSettled).toBe(false);
    expect(manager.getChat(rcsSessionId)).toBeUndefined();
    expect(broadcasts).toEqual([]);

    redis.releaseEval();
    const replacement = await replacementPromise;
    const opened = await opening;

    expect(opened).toBe(replacement.chat);
    expect(opened.generation).toBe(replacement.generation);
    expect(manager.getChat(rcsSessionId)).toBe(replacement.chat);
    // 被换代取代的加载 Doc 必须销毁 provider，不能泄漏订阅 / 持久化连接。
    expect(redis.persistences[persistenceCountBeforeOpen]?.disconnected).toBe(true);
    expect(redis.subscribers[subscriberCountBeforeOpen]?.disconnected).toBe(true);
    expect(broadcasts).toEqual([]);
    await manager.closeAll();
  });

  // close 发生在 publish await 窗口：关闭优先，replace 必须放弃提交且不得把 Doc 写回 map。
  test("close 发生在 replace 的 publish await 窗口时不复活 map", async () => {
    const rcsSessionId = "rcs_fence_publish_window_close";
    const redis = new GatedEvalRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    const manager = createManager(() => redis);

    const replacementPromise = manager.replaceProjection(rcsSessionId, "ses_replacement");
    await waitFor(() => redis.evalStarted, "publishActiveGeneration eval");

    await manager.closeChat(rcsSessionId);
    await manager.closeSession(rcsSessionId);
    expect(manager.getChat(rcsSessionId)).toBeUndefined();
    expect(manager.getSession(rcsSessionId)).toBeUndefined();

    redis.releaseEval();
    await expect(replacementPromise).rejects.toThrow("superseded by close");

    expect(manager.getChat(rcsSessionId)).toBeUndefined();
    expect(manager.getSession(rcsSessionId)).toBeUndefined();
    // 被放弃提交的新 Doc 已销毁：两个 provider 的持久化与订阅连接都断开。
    expect(redis.persistences.slice(0, 2).map((connection) => connection.disconnected)).toEqual([true, true]);
    expect(redis.subscribers.slice(0, 2).map((connection) => connection.disconnected)).toEqual([true, true]);
    await manager.closeAll();
  });

  // replace CAS 失败（active generation 未变）时，在途 open 不得被误判为“已关闭”。
  test("replace CAS 失败时 openChat 返回旧 projection 的 Doc", async () => {
    const rcsSessionId = "rcs_fence_cas_failure";
    const redis = new FakeRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis);

    const opening = manager.openChat(rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "chat snapshot read");
    await expect(manager.replaceProjection(rcsSessionId, "ses_replacement")).rejects.toThrow(
      "projection generation changed concurrently",
    );

    gate.resolve();
    const opened = await opening;

    expect(opened.generation).toBe(GENERATION);
    expect(opened.hydration.status).toBe("loaded");
    expect(historyValues(opened.ydoc)).toEqual(["old-history"]);
    expect(manager.getChat(rcsSessionId)).toBe(opened);
    // 加载结果被采纳，provider 仍连接；关闭时才释放。
    expect(redis.persistences[0]?.disconnected).toBe(false);
    await manager.closeAll();
    expect(redis.persistences[0]?.disconnected).toBe(true);
  });

  // closeAll 必须让在途 open 拒绝且不安装 Doc，同时清理 fence 使后续 open 正常。
  test("closeAll 后在途 open 不安装 Doc，再次 open 正常", async () => {
    const rcsSessionId = "rcs_fence_close_all";
    const broadcasts: string[] = [];
    const redis = new FakeRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("history-after-close-all"));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const opening = manager.openChat(rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "chat snapshot read");
    await manager.closeAll();

    gate.resolve();
    await expect(opening).rejects.toThrow("chat doc was closed during open");
    expect(manager.getChat(rcsSessionId)).toBeUndefined();
    expect(broadcasts).toEqual([]);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);

    // fence 已清理：新的 open 不受 shutdown epoch 残留影响。
    const reopened = await manager.openChat(rcsSessionId);
    expect(reopened.generation).toBe(GENERATION);
    expect(historyValues(reopened.ydoc)).toEqual(["history-after-close-all"]);
    expect(manager.getChat(rcsSessionId)).toBe(reopened);
    await manager.closeAll();
  });

  // GETBUFFER 后 apply 前换代：旧水合必须是 stale，DocManager 有界重试读取新 active generation。
  test("GETBUFFER 后 apply 前换代时 openChat 有界重试并返回新世代", async () => {
    const rcsSessionId = "rcs_fence_stale_retry";
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    redis.seedSnapshot(`chat:${rcsSessionId}`, REPLACED_EXTERNALLY, chatSnapshotWithText("new-history"));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis);

    const opening = manager.openChat(rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "chat snapshot read");
    // 模拟另一进程在水合窗口内提交换代（本进程 map 中没有新 Doc）。
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);

    gate.resolve();
    const opened = await opening;

    expect(opened.generation).toBe(REPLACED_EXTERNALLY);
    expect(opened.hydration.status).toBe("loaded");
    expect(historyValues(opened.ydoc)).toEqual(["new-history"]);
    expect(manager.getChat(rcsSessionId)).toBe(opened);
    // 旧世代的 provider 在水合失败时已销毁。
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // provider 层语义：GETBUFFER 返回后被换代，hydration 必须是 stale 而不是 loaded/empty。
  test("redis provider 在 apply 前观察到换代时报告 stale hydration", async () => {
    const rcsSessionId = "rcs_fence_provider_stale";
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);

    const ydoc = new Y.Doc();
    const provider = createRedisProvider(redis as never, `chat:${rcsSessionId}`, ydoc, {
      generation: GENERATION,
      snapshot: SNAPSHOT_CONFIG,
    });
    await waitFor(() => redis.bufferReads.length > 0, "snapshot read");
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);

    gate.resolve();
    const outcome = await provider.hydration;
    expect(outcome.status).toBe("stale");

    await provider.destroy();
    ydoc.destroy();
  });
});
