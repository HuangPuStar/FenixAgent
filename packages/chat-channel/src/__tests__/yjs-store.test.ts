// packages/chat-channel/src/__tests__/yjs-store.test.ts
// Yjs 外部 store 的纯内存测试：验证二进制更新、会话隔离、事务通知与资源生命周期。

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { applyRemoteDocUpdate, createYjsStore } from "../state/yjs-store";

interface Snapshot {
  value: string | null;
}

function snapshotOf(ydoc: Y.Doc): Snapshot {
  const value = ydoc.getMap("root").get("value");
  return { value: typeof value === "string" ? value : null };
}

function waitForScheduledRecompute(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 本地事务应同步更新快照并只通知已订阅的监听器。
test("本地事务同步投影并支持取消订阅", () => {
  const store = createYjsStore(snapshotOf, { value: null });
  const doc = new Y.Doc();
  const notifications: Snapshot[] = [];
  const unsubscribe = store.subscribe(() => notifications.push(store.getSnapshot()));

  store.switchDoc("rcs_a", () => ({ ydoc: doc }));
  unsubscribe();
  doc.transact(() => doc.getMap("root").set("value", "local"));

  expect(store.getSnapshot()).toEqual({ value: "local" });
  expect(notifications).toEqual([{ value: null }]);
  store.destroy();
});

// 编码后的远端更新仅在 session 匹配时异步应用，错误 session 不得污染当前文档。
test("二进制远端更新按会话隔离并合并异步重算", async () => {
  const store = createYjsStore(snapshotOf, { value: null });
  const target = new Y.Doc();
  target.getMap("meta").set("acpSessionId", "ses_a");
  const source = new Y.Doc();
  source.getMap("root").set("value", "remote");
  const update = Y.encodeStateAsUpdate(source);
  let notifications = 0;

  store.switchDoc("rcs_a", () => ({ ydoc: target }));
  store.subscribe(() => notifications++);
  store.applyUpdate(update, "ses_b");
  await waitForScheduledRecompute();

  expect(store.getSnapshot()).toEqual({ value: null });
  expect(notifications).toBe(0);

  store.applyUpdate(update, "ses_a");
  expect(store.getSnapshot()).toEqual({ value: null });
  await waitForScheduledRecompute();

  expect(store.getSnapshot()).toEqual({ value: "remote" });
  expect(notifications).toBe(1);
  store.destroy();
  source.destroy();
});

// 同一 Y.Doc 的远端单写入口应使每个绑定 store 收敛，互不相关的文档不受影响。
test("共享文档的远端单写与独立会话文档保持隔离", async () => {
  const shared = new Y.Doc();
  const isolated = new Y.Doc();
  const first = createYjsStore(snapshotOf, { value: null });
  const second = createYjsStore(snapshotOf, { value: null });
  const other = createYjsStore(snapshotOf, { value: null });
  const source = new Y.Doc();
  source.getMap("root").set("value", "shared-update");

  first.switchDoc("rcs_a", () => ({ ydoc: shared, ownsDoc: false }));
  second.switchDoc("rcs_a-copy", () => ({ ydoc: shared, ownsDoc: false }));
  other.switchDoc("rcs_b", () => ({ ydoc: isolated, ownsDoc: false }));
  applyRemoteDocUpdate(shared, Y.encodeStateAsUpdate(source));
  await waitForScheduledRecompute();

  expect(first.getSnapshot()).toEqual({ value: "shared-update" });
  expect(second.getSnapshot()).toEqual({ value: "shared-update" });
  expect(other.getSnapshot()).toEqual({ value: null });

  first.destroy();
  second.destroy();
  other.destroy();
  shared.destroy();
  isolated.destroy();
  source.destroy();
});

// 切换或销毁 store 必须释放回调且不能销毁外部持有的共享文档。
test("切换和销毁释放 cleanup 并保留共享文档所有权", () => {
  const store = createYjsStore(snapshotOf, { value: null });
  const shared = new Y.Doc();
  const replacement = new Y.Doc();
  let cleanupCalls = 0;
  let sharedDestroyed = false;
  let replacementDestroyed = false;
  shared.on("destroy", () => {
    sharedDestroyed = true;
  });
  replacement.on("destroy", () => {
    replacementDestroyed = true;
  });

  store.switchDoc("shared", () => ({
    ydoc: shared,
    ownsDoc: false,
    cleanup: () => cleanupCalls++,
  }));
  store.switchDoc("replacement", () => ({
    ydoc: replacement,
    cleanup: () => cleanupCalls++,
  }));
  store.destroy();

  expect(cleanupCalls).toBe(2);
  expect(sharedDestroyed).toBe(false);
  expect(replacementDestroyed).toBe(true);

  shared.getMap("root").set("value", "still-owned-externally");
  shared.destroy();
  expect(sharedDestroyed).toBe(true);
});
