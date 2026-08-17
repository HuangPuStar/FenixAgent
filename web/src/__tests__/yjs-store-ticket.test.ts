// web/src/__tests__/yjs-store-ticket.test.ts
// createYjsStore 变更票据（SP-B3）专项测试：票据 `${projectionVersion}:${docUpdateSeq}`
// 的三个关键语义——seq 兜底本地事务、switchDoc 票据重置、无 update（幂等重放）不通知。
// 与 yjs-store.test.ts（通知行为 + applyUpdate 合并重算调度）互补，本文件用最小快照形状。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createYjsStore } from "@fenix/chat-channel";
import * as Y from "yjs";

interface TicketTestSnapshot {
  messageCount: number;
}

/** 最小快照：只统计消息数量，足以驱动通知断言 */
function computeTicketTestSnapshot(ydoc: Y.Doc): TicketTestSnapshot {
  return { messageCount: ydoc.getArray("messages").length };
}

/** 在 doc 中写入一条消息（本地事务，origin 非 applyUpdate） */
function writeMessage(ydoc: Y.Doc, content: string) {
  ydoc.transact(() => {
    const messages = ydoc.getArray("messages");
    const msg = new Y.Map<unknown>();
    msg.set("role", "user");
    msg.set("content", content);
    messages.push([msg]);
  });
}

/** 用独立源 doc 编码一条消息的 update，模拟 WS 增量帧 */
function encodeMessageUpdate(content: string): Uint8Array {
  const src = new Y.Doc();
  writeMessage(src, content);
  return Y.encodeStateAsUpdate(src);
}

/** 等待宏任务队列中的合并重算执行完毕 */
function flushRecompute(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("createYjsStore 变更票据语义", () => {
  let ydoc: Y.Doc;
  let store: ReturnType<typeof createYjsStore<TicketTestSnapshot>>;
  let notifyCount: number;

  beforeEach(() => {
    ydoc = new Y.Doc();
    notifyCount = 0;
    store = createYjsStore<TicketTestSnapshot>(computeTicketTestSnapshot, { messageCount: 0 });
    store.switchDoc("test", () => ({ ydoc }));
    store.subscribe(() => {
      notifyCount++;
    });
    notifyCount = 0;
  });

  afterEach(() => {
    store.destroy();
  });

  // 本地事务（非 APPLY_UPDATE_ORIGIN）不 bump projectionVersion 时，由 docUpdateSeq
  // 兜底推进票据——保证测试直写与本地写入路径快照立即可见，不因版本段恒为 0 而漏通知
  test("本地事务无 projectionVersion 时仍由 docUpdateSeq 兜底通知", () => {
    // 测试自建 doc 不写入 root.projectionVersion（票据版本段恒为 0）
    expect(ydoc.getMap("root").get("projectionVersion")).toBeUndefined();

    writeMessage(ydoc, "hello");

    // seq 段推进（0:1 ≠ ""）→ 同步重算并通知
    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().messageCount).toBe(1);
  });

  // switchDoc 重置票据：新 doc 首次写入即使票据值与旧 doc 上次写入相同也通知——
  // 若票据未随 switchDoc 重置（prevSnapshotKey 残留旧 doc 值），会误判为未变而漏通知
  test("switchDoc 重置票据：新 doc 首次写入仍通知", () => {
    writeMessage(ydoc, "hello");

    const nextDoc = new Y.Doc();
    store.switchDoc("other", () => ({ ydoc: nextDoc }));
    notifyCount = 0;

    // 新 doc 的首个 update 票据为 "0:1"，与旧 doc 首次写入相同
    writeMessage(nextDoc, "hello");

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().messageCount).toBe(1);
  });

  // 幂等重放：applyUpdate 应用同一份 update（同 client+clock，Yjs 无新增内容，
  // 不 emit update 事件）→ 票据（seq 段）不变 → 0 次额外通知
  test("applyUpdate 幂等重放无 update 事件，票据不变不通知", async () => {
    const update = encodeMessageUpdate("hello");
    store.applyUpdate(update);
    await flushRecompute();
    expect(notifyCount).toBe(1);

    // 重放同一份 update（服务端重发/幂等帧场景）：Yjs 检测到已存在，doc 无 update
    store.applyUpdate(update);
    await flushRecompute();

    expect(notifyCount).toBe(1);
  });
});
