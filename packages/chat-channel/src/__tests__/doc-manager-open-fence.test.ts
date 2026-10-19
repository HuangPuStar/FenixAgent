// packages/chat-channel/src/__tests__/doc-manager-open-fence.test.ts
// 投影生命周期并发回归：区分 close、replace 成功、replace 失败三类事件。
//
// 覆盖生产 Redis active generation 路径：慢水合期间换代、publish await 窗口内 open/close、
// CAS 失败误伤、closeAll 与在途 open、GETBUFFER 后 apply 前换代。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createRedisProvider } from "../persist/redis";
import {
  chatSnapshotWithText,
  createManager,
  deferred,
  GatedEvalRedis,
  GENERATION,
  historyValues,
  ProdRedis,
  REPLACED_EXTERNALLY,
  SNAPSHOT_CONFIG,
  sessionSnapshot,
  waitFor,
} from "./helpers/doc-manager-fixtures";
import { FakeRedis } from "./helpers/fake-redis";

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
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, sessionSnapshot());
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
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, sessionSnapshot());
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
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, sessionSnapshot());
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
});
