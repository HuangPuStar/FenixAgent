// packages/chat-channel/src/__tests__/doc-manager-fastpath.test.ts
// 已驻留 Doc 的快路径复核回归：跨进程换代收敛、Redis 故障降级、并发 open 合并与关闭窗口。
//
// 使用与 doc-manager-open-fence.test.ts 相同的 Redis 双与闸门，仅按主题拆分文件。

import { describe, expect, test } from "bun:test";
import { getEntriesMap, getEntryOrder } from "../state/chat-writer";
import {
  chatSnapshotWithText,
  createManager,
  FailActiveGenerationRedis,
  GatedFastPathRedis,
  GENERATION,
  gateYDocDestroy,
  historyValues,
  ProdRedis,
  REPLACED_EXTERNALLY,
  ReturnWindowRedis,
  sessionSnapshot,
  waitFor,
} from "./helpers/doc-manager-fixtures";

describe("DocManager 投影生命周期栅栏（快路径）", () => {
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
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, sessionSnapshot());
    const manager = createManager(() => redis);

    const first = await manager.openSession("user-1", "agent-1", rcsSessionId);
    expect(first.generation).toBe(GENERATION);

    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, sessionSnapshot());

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

  // Redis 故障时 Chat 快路径降级复用已驻留 Doc：不重载、不广播，用户消息仍能写入。
  test("Redis 故障时 Chat 快路径复用原 Doc 并保留用户消息写入", async () => {
    const rcsSessionId = "rcs_fence_fastpath_chat_outage";
    const broadcasts: string[] = [];
    const errors: Array<{ context: string; error: unknown }> = [];
    const redis = new FailActiveGenerationRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`chat:${rcsSessionId}`, GENERATION, chatSnapshotWithText("history"));
    const manager = createManager(() => redis, {
      onYjsUpdate: (docName) => broadcasts.push(docName),
      onError: (context, error) => errors.push({ context, error }),
    });

    const chat = await manager.openChat(rcsSessionId);
    await manager.openSession("user-1", "agent-1", rcsSessionId);
    const providerCount = redis.persistences.length;
    const subscriberCount = redis.subscribers.length;
    redis.failActiveGeneration = true;

    const reopened = await manager.openChat(rcsSessionId);

    expect(reopened).toBe(chat);
    expect(manager.getChat(rcsSessionId)).toBe(chat);
    // 未重载：provider 数量不变且原连接仍在使用；open 本身不产生广播。
    expect(redis.persistences.length).toBe(providerCount);
    expect(redis.subscribers.length).toBe(subscriberCount);
    expect(redis.persistences.every((persistence) => !persistence.disconnected)).toBe(true);
    expect(redis.subscribers.every((subscriber) => !subscriber.disconnected)).toBe(true);
    expect(broadcasts).toEqual([]);
    expect(errors.some(({ context }) => context.includes("active generation revalidation failed"))).toBe(true);

    const entriesBefore = getEntryOrder(chat.ydoc).length;
    const turnId = manager.registerUserMessage(rcsSessionId, "message during outage");

    expect(typeof turnId).toBe("string");
    // user entry + 预置的 assistant pending entry 各一条。
    expect(getEntryOrder(chat.ydoc).length).toBe(entriesBefore + 2);
    expect(getEntriesMap(chat.ydoc).get(`${turnId}:user`)).toBeDefined();
    await manager.closeAll();
  });

  // Session 快路径同一降级语义：active generation 复核失败时返回原 Doc，不重载不销毁。
  test("Redis 故障时 Session 快路径复用原 Doc", async () => {
    const rcsSessionId = "rcs_fence_fastpath_session_outage";
    const errors: Array<{ context: string; error: unknown }> = [];
    const redis = new FailActiveGenerationRedis();
    redis.seedActiveGeneration(rcsSessionId, GENERATION);
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, sessionSnapshot());
    const manager = createManager(() => redis, {
      onError: (context, error) => errors.push({ context, error }),
    });

    const first = await manager.openSession("user-1", "agent-1", rcsSessionId);
    redis.failActiveGeneration = true;

    const reopened = await manager.openSession("user-1", "agent-1", rcsSessionId);

    expect(reopened).toBe(first);
    expect(manager.getSession(rcsSessionId)).toBe(first);
    expect(redis.persistences.length).toBe(1);
    expect(redis.subscribers.length).toBe(1);
    expect(redis.persistences[0]?.disconnected).toBe(false);
    expect(redis.subscribers[0]?.disconnected).toBe(false);
    expect(errors.some(({ context }) => context.includes("active generation revalidation failed"))).toBe(true);
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
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, sessionSnapshot());
    const manager = createManager(() => redis);

    const first = await manager.openSession("user-1", "agent-1", rcsSessionId);
    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, sessionSnapshot());
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
    let manager: ReturnType<typeof createManager> | null = null;
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
    let manager: ReturnType<typeof createManager> | null = null;
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
    redis.seedSnapshot(`session:${rcsSessionId}`, GENERATION, sessionSnapshot());
    const manager = createManager(() => redis, { onYjsUpdate: (docName) => broadcasts.push(docName) });

    const first = await manager.openSession("user-1", "agent-1", rcsSessionId);
    expect(first.generation).toBe(GENERATION);

    redis.seedActiveGeneration(rcsSessionId, REPLACED_EXTERNALLY);
    redis.seedSnapshot(`session:${rcsSessionId}`, REPLACED_EXTERNALLY, sessionSnapshot());

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
