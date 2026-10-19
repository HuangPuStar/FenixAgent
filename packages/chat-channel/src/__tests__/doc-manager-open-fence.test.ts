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
  /** active-generation 读取次数，用于确认 open 已完成水合并进入安装前等待。 */
  activeGenGets = 0;
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

  override get(key: string): Promise<string | null> {
    if (key.startsWith("yjs:active-generation:")) this.activeGenGets += 1;
    return super.get(key);
  }

  releaseEval(): void {
    this.gate.resolve();
  }
}

/** 让快路径的 active generation 复核停在 await 窗口，验证并发 open 共享同一 opening。 */
class GatedFastPathRedis extends ProdRedis {
  gatedGets = 0;
  private armed = false;
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  arm(): void {
    this.armed = true;
    this.gatedGets = 0;
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.armed = false;
    this.releaseGate?.();
  }

  override async get(key: string): Promise<string | null> {
    const value = await super.get(key);
    if (this.armed && key.startsWith("yjs:active-generation:")) {
      this.gatedGets += 1;
      await this.gate;
    }
    return value;
  }
}

/** 在 Doc 安装完成后、open 外层续体前触发 close，复现「返回已销毁 Doc」的窗口。 */
class ReturnWindowRedis extends ProdRedis {
  private bufferDone = false;
  private generationGetsAfterBuffer = 0;

  constructor(private readonly onWindow: () => void) {
    super();
  }

  override async getBuffer(key: string): Promise<Buffer | null> {
    const value = await super.getBuffer(key);
    this.bufferDone = true;
    return value;
  }

  override get(key: string): Promise<string | null> {
    const base = super.get(key);
    if (!this.bufferDone || !key.startsWith("yjs:active-generation:")) return base;
    this.generationGetsAfterBuffer += 1;
    if (this.generationGetsAfterBuffer !== 2) return base;
    return new Promise<string | null>((resolve) => {
      base.then((value) => {
        resolve(value);
        // get → getActiveGeneration → isGenerationCurrent + finalize 返回共 4 层微任务：
        // close 恰好落在安装完成之后、openChat/openSession 外层续体之前。
        queueMicrotask(() =>
          queueMicrotask(() =>
            queueMicrotask(() =>
              queueMicrotask(() => {
                this.onWindow();
              }),
            ),
          ),
        );
      });
    });
  }
}

/**
 * 在指定旧世代 Doc 的 Y.Doc.destroy 处暂停。此时旧 Doc 已从 map 删除、provider 已释放，
 * 但 openInternal 尚未捕获内部 fence 快照，正好暴露快路径删除后的关闭窗口。
 */
function gateYDocDestroy(guid: string): { hit: Promise<void>; release: () => void; restore: () => void } {
  const original = Y.Doc.prototype.destroy;
  const hit = deferred();
  const gate = deferred();
  Y.Doc.prototype.destroy = function (this: Y.Doc) {
    if (this.guid !== guid) return original.call(this);
    hit.resolve();
    return gate.promise.then(() => original.call(this));
  };
  return {
    hit: hit.promise,
    release: gate.resolve,
    restore: () => {
      Y.Doc.prototype.destroy = original;
    },
  };
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

  // 无旧快照时 GETBUFFER 窗口内换代：旧世代的“空历史”必须判 stale，openChat 返回新世代。
  test("无旧快照时 GETBUFFER 窗口内换代 openChat 返回新世代 Doc", async () => {
    const rcsSessionId = "rcs_fence_empty_stale_chat";
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    // 旧世代没有快照；新世代已有另一进程落盘的历史。
    redis.seedSnapshot(`chat:${rcsSessionId}`, REPLACED_EXTERNALLY, chatSnapshotWithText("new-history"));
    const gate = deferred();
    redis.delayBuffer(`yjs:chat:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis);

    const opening = manager.openChat(rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "old generation GETBUFFER");
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    gate.resolve();

    const opened = await opening;
    expect(opened.generation).toBe(REPLACED_EXTERNALLY);
    expect(opened.hydration.status).toBe("loaded");
    expect(historyValues(opened.ydoc)).toEqual(["new-history"]);
    expect(manager.getChat(rcsSessionId)?.generation).toBe(REPLACED_EXTERNALLY);
    // 旧世代 provider 在 stale 时已销毁，不得继续订阅 / 持久化。
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // Session 无旧快照的同类窗口：openSession 同样必须返回当前 active generation。
  test("无旧快照时 GETBUFFER 窗口内换代 openSession 返回新世代 Doc", async () => {
    const rcsSessionId = "rcs_fence_empty_stale_session";
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, snapshotOf(initSessionDocStructure));
    const gate = deferred();
    redis.delayBuffer(`yjs:session:${rcsSessionId}:${GENERATION}`, gate.promise);
    const manager = createManager(() => redis);

    const opening = manager.openSession("user-1", "agent-1", rcsSessionId);
    await waitFor(() => redis.bufferReads.length > 0, "old generation GETBUFFER");
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    gate.resolve();

    const opened = await opening;
    expect(opened.generation).toBe(REPLACED_EXTERNALLY);
    expect(opened.hydration.status).toBe("loaded");
    expect(manager.getSession(rcsSessionId)?.generation).toBe(REPLACED_EXTERNALLY);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // close 删除 fence 登记后、replace 仍停在 publish await：新 open 不得安装旧世代 Doc。
  test("close 删除登记后在途 publish 期间新 open 不安装旧世代 Doc", async () => {
    const rcsSessionId = "rcs_fence_close_reopen_publish";
    const broadcasts: string[] = [];
    const redis = new GatedEvalRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, snapshotOf(initSessionDocStructure));
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    // 暂缓销毁被丢弃的旧世代 Chat Doc，测试写入一次 update 验证其从未注册广播。
    const originalDestroy = Y.Doc.prototype.destroy;
    const discardedGuid = `chat:${rcsSessionId}:${GENERATION}`;
    let discardedDoc: Y.Doc | null = null;
    Y.Doc.prototype.destroy = function (this: Y.Doc) {
      if (this.guid === discardedGuid) {
        discardedDoc = this;
        return;
      }
      originalDestroy.call(this);
    };
    try {
      const replacementPromise = manager.replaceProjection(rcsSessionId, "ses_replacement");
      await waitFor(() => redis.evalStarted, "publishActiveGeneration eval");
      // close 删除 fence 登记；在途 replace 仍停在 publish await。
      await manager.closeChat(rcsSessionId);
      await manager.closeSession(rcsSessionId);

      const opening = manager.openChat(rcsSessionId);
      // 4 次 active-generation GET = replace 1 + open 1 + provider 前后各 1：
      // 说明本次 open 已完成水合、停在安装前等待在途换代。
      await waitFor(() => redis.activeGenGets >= 4, "open waits for in-flight replacement");
      await new Promise((resolve) => setTimeout(resolve, 10));

      redis.releaseEval();
      await expect(replacementPromise).rejects.toThrow("superseded by close");
      const opened = await opening;
      const active = await redis.get(`yjs:active-generation:${rcsSessionId}`);

      expect(active).not.toBe(GENERATION);
      expect(opened.generation).toBe(active);
      expect(manager.getChat(rcsSessionId)?.generation).toBe(active);

      const staleDoc = discardedDoc;
      if (!staleDoc) throw new Error("expected the old-generation chat doc to be discarded");
      staleDoc.getMap("root").set("broadcast-leak-probe", 1);
      expect(broadcasts).toEqual([]);
    } finally {
      Y.Doc.prototype.destroy = originalDestroy;
      if (discardedDoc) originalDestroy.call(discardedDoc);
      await manager.closeAll();
    }
  });

  // Redis 快路径必须复核 active generation：外部换代后再次 openChat 收敛到新世代并释放旧连接。
  test("快路径在外部换代后重新加载 Chat Doc 并释放旧连接", async () => {
    const rcsSessionId = "rcs_fence_fastpath_chat";
    const broadcasts: string[] = [];
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const first = await manager.openChat(rcsSessionId);
    expect(first.generation).toBe(GENERATION);
    expect(redis.persistences.length).toBe(1);
    expect(redis.subscribers.length).toBe(1);

    // 另一进程推进 active generation 并落盘新世代历史；本进程 map 仍驻留旧 Doc。
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`chat:${rcsSessionId}`, REPLACED_EXTERNALLY, chatSnapshotWithText("new-history"));

    const second = await manager.openChat(rcsSessionId);

    expect(second).not.toBe(first);
    expect(second.generation).toBe(REPLACED_EXTERNALLY);
    expect(historyValues(second.ydoc)).toEqual(["new-history"]);
    expect(manager.getChat(rcsSessionId)).toBe(second);
    // 旧世代的持久化与订阅连接已释放，新世代仍连接。
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    expect(redis.persistences[1]?.disconnected).toBe(false);
    expect(redis.subscribers[1]?.disconnected).toBe(false);
    // 广播只绑定新世代：旧 Doc 不会产生任何更新。
    second.ydoc.getMap("root").set("fastpath-probe", "ok");
    expect(broadcasts).toEqual([`chat:${rcsSessionId}`]);
    await manager.closeAll();
  });

  // Session 快路径同语义：外部换代后 openSession 收敛到新世代并释放旧连接。
  test("快路径在外部换代后重新加载 Session Doc 并释放旧连接", async () => {
    const rcsSessionId = "rcs_fence_fastpath_session";
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, snapshotOf(initSessionDocStructure));
    const manager = createManager(() => redis);

    const first = await manager.openSession("user-1", "agent-1", rcsSessionId);
    expect(first.generation).toBe(GENERATION);

    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, snapshotOf(initSessionDocStructure));

    const second = await manager.openSession("user-1", "agent-1", rcsSessionId);

    expect(second).not.toBe(first);
    expect(second.generation).toBe(REPLACED_EXTERNALLY);
    expect(manager.getSession(rcsSessionId)).toBe(second);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    expect(redis.persistences[1]?.disconnected).toBe(false);
    expect(redis.subscribers[1]?.disconnected).toBe(false);
    await manager.closeAll();
  });

  // 两个并发 openChat 在旧世代复核窗口内必须共享一次重载，不重复创建 provider。
  test("并发 openChat 在快路径复核期间只重载一次", async () => {
    const rcsSessionId = "rcs_fence_fastpath_concurrent_chat";
    const broadcasts: string[] = [];
    const redis = new GatedFastPathRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const first = await manager.openChat(rcsSessionId);
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`chat:${rcsSessionId}`, REPLACED_EXTERNALLY, chatSnapshotWithText("new-history"));
    redis.arm();

    const openingA = manager.openChat(rcsSessionId);
    const openingB = manager.openChat(rcsSessionId);
    await waitFor(() => redis.gatedGets === 2, "both fast-path generation checks");
    redis.release();

    const [a, b] = await Promise.all([openingA, openingB]);

    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(a.generation).toBe(REPLACED_EXTERNALLY);
    expect(historyValues(a.ydoc)).toEqual(["new-history"]);
    expect(manager.getChat(rcsSessionId)).toBe(a);
    // 初始 + 一次重载各一对 provider；若并发重复加载这里会是 3 对。
    expect(redis.persistences.length).toBe(2);
    expect(redis.subscribers.length).toBe(2);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    expect(redis.persistences[1]?.disconnected).toBe(false);
    expect(redis.subscribers[1]?.disconnected).toBe(false);
    expect(broadcasts).toEqual([]);
    await manager.closeAll();
  });

  // Session 并发快路径同样共享一次重载，不泄漏重复 provider。
  test("并发 openSession 在快路径复核期间只重载一次", async () => {
    const rcsSessionId = "rcs_fence_fastpath_concurrent_session";
    const redis = new GatedFastPathRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, snapshotOf(initSessionDocStructure));
    const manager = createManager(() => redis);

    const first = await manager.openSession("user-1", "agent-1", rcsSessionId);
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, snapshotOf(initSessionDocStructure));
    redis.arm();

    const openingA = manager.openSession("user-1", "agent-1", rcsSessionId);
    const openingB = manager.openSession("user-1", "agent-1", rcsSessionId);
    await waitFor(() => redis.gatedGets === 2, "both fast-path generation checks");
    redis.release();

    const [a, b] = await Promise.all([openingA, openingB]);

    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(a.generation).toBe(REPLACED_EXTERNALLY);
    expect(manager.getSession(rcsSessionId)).toBe(a);
    expect(redis.persistences.length).toBe(2);
    expect(redis.subscribers.length).toBe(2);
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    expect(redis.persistences[1]?.disconnected).toBe(false);
    expect(redis.subscribers[1]?.disconnected).toBe(false);
    await manager.closeAll();
  });

  // close 落在安装完成之后、openChat 返回之前：必须拒绝，不得把已销毁 Doc 交给调用方。
  test("close 落在安装后返回前时 openChat 拒绝并释放连接", async () => {
    const rcsSessionId = "rcs_fence_return_window_chat";
    let manager: DocManager | null = null;
    let installedAtClose = false;
    const redis = new ReturnWindowRedis(() => {
      installedAtClose = manager?.getChat(rcsSessionId) !== undefined;
      void manager?.closeChat(rcsSessionId);
    });
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    manager = createManager(() => redis);

    await expect(manager.openChat(rcsSessionId)).rejects.toThrow("chat doc was closed during open");
    await waitFor(() => redis.persistences[0]?.disconnected === true, "close destroy chat provider");

    expect(installedAtClose).toBe(true);
    expect(manager.getChat(rcsSessionId)).toBeUndefined();
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // Session 的同一返回窗口：closeSession 落在安装后，openSession 必须拒绝。
  test("close 落在安装后返回前时 openSession 拒绝并释放连接", async () => {
    const rcsSessionId = "rcs_fence_return_window_session";
    let manager: DocManager | null = null;
    let installedAtClose = false;
    const redis = new ReturnWindowRedis(() => {
      installedAtClose = manager?.getSession(rcsSessionId) !== undefined;
      void manager?.closeSession(rcsSessionId);
    });
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    manager = createManager(() => redis);

    await expect(manager.openSession("user-1", "agent-1", rcsSessionId)).rejects.toThrow(
      "session doc was closed during open",
    );
    await waitFor(() => redis.persistences[0]?.disconnected === true, "close destroy session provider");

    expect(installedAtClose).toBe(true);
    expect(manager.getSession(rcsSessionId)).toBeUndefined();
    expect(redis.persistences[0]?.disconnected).toBe(true);
    expect(redis.subscribers[0]?.disconnected).toBe(true);
    await manager.closeAll();
  });

  // 快路径 stale 删除旧 Chat Doc 后、重载安装前 close：open 必须拒绝且不得复活。
  test("快路径 stale 重载期间 closeChat 不复活 Chat Doc", async () => {
    const rcsSessionId = "rcs_fence_fastpath_close_window_chat";
    const broadcasts: string[] = [];
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("old-history"));
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const first = await manager.openChat(rcsSessionId);
    expect(first.generation).toBe(GENERATION);

    // 另一进程推进世代：下一次 open 走快路径 stale → 删除 → 重载。
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`chat:${rcsSessionId}`, REPLACED_EXTERNALLY, chatSnapshotWithText("new-history"));

    const destroyGate = gateYDocDestroy(`chat:${rcsSessionId}:${GENERATION}`);
    try {
      const opening = manager.openChat(rcsSessionId);
      // 暂停点：旧 Doc 已从 map 删除，openChatInternal 尚未捕获内部 fence 快照。
      await destroyGate.hit;
      expect(manager.getChat(rcsSessionId)).toBeUndefined();

      await manager.closeChat(rcsSessionId);
      destroyGate.release();

      await expect(opening).rejects.toThrow("chat doc was closed during open");

      expect(manager.getChat(rcsSessionId)).toBeUndefined();
      // 旧 Doc 与本次重载的 Doc 均释放 provider 连接，且重载结果从未注册广播。
      expect(redis.persistences.map((connection) => connection.disconnected)).toEqual([true, true]);
      expect(redis.subscribers.map((connection) => connection.disconnected)).toEqual([true, true]);
      expect(broadcasts).toEqual([]);
    } finally {
      destroyGate.release();
      destroyGate.restore();
      await manager.closeAll();
    }
  });

  // Session 的同一窗口：快路径 stale 删除旧 Doc 后、重载安装前 close，open 必须拒绝。
  test("快路径 stale 重载期间 closeSession 不复活 Session Doc", async () => {
    const rcsSessionId = "rcs_fence_fastpath_close_window_session";
    const broadcasts: string[] = [];
    const redis = new ProdRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, snapshotOf(initSessionDocStructure));
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const first = await manager.openSession("user-1", "agent-1", rcsSessionId);
    expect(first.generation).toBe(GENERATION);

    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, snapshotOf(initSessionDocStructure));

    const destroyGate = gateYDocDestroy(`session:${rcsSessionId}:${GENERATION}`);
    try {
      const opening = manager.openSession("user-1", "agent-1", rcsSessionId);
      await destroyGate.hit;
      expect(manager.getSession(rcsSessionId)).toBeUndefined();

      await manager.closeSession(rcsSessionId);
      destroyGate.release();

      await expect(opening).rejects.toThrow("session doc was closed during open");

      expect(manager.getSession(rcsSessionId)).toBeUndefined();
      expect(redis.persistences.map((connection) => connection.disconnected)).toEqual([true, true]);
      expect(redis.subscribers.map((connection) => connection.disconnected)).toEqual([true, true]);
      expect(broadcasts).toEqual([]);
    } finally {
      destroyGate.release();
      destroyGate.restore();
      await manager.closeAll();
    }
  });
});
