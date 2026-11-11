// packages/chat-channel/src/channel/gateway-sync.test.ts
// 旧 Chat Doc 初始同步的投递结果：超过累计预算时必须返回失败、通知客户端缺失文档，
// 不能把“没有发出任何数据”记成握手完成。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { MAX_YJS_SYNC_PAYLOAD_BYTES, MAX_YJS_TRANSFER_BYTES } from "../protocol/update-frame";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createWs, textFrames } from "./connection-test-helpers";
import { noteInitialSyncDelivery, type PendingInitialSync, synchronizeInitialDocs } from "./gateway-sync";

const RCS_SESSION_ID = "rcs-1";
const GENERATION = "gen-big";
const CHAT_DOC_NAME = `chat:${RCS_SESSION_ID}`;
const SESSION_DOC_NAME = `session:${RCS_SESSION_ID}`;

function docs(chatText = "hello") {
  const chatDoc = new Y.Doc();
  chatDoc.getMap("chat").set("title", chatText);
  const sessionDoc = new Y.Doc();
  sessionDoc.getMap("session").set("status", "ready");
  return {
    chatDoc: { ydoc: chatDoc, generation: GENERATION },
    sessionDoc: { ydoc: sessionDoc, generation: GENERATION },
  };
}

function incompleteFrames(ws: ReturnType<typeof createWs>): Array<Record<string, unknown>> {
  return textFrames(ws)
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.type === "yjs:history-incomplete");
}

describe("旧 Chat Doc 初始同步", () => {
  // Session 先换代或任一投影消失时，旧 Chat 不能单独证明成对历史已恢复。
  test.each(["session-changed", "missing"] as const)("当前投影 %s 时不报告旧代同步完成", async (condition) => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    const pair = docs();
    const pending = new Map<string, PendingInitialSync>();
    const result = synchronizeInitialDocs(
      pending,
      broadcaster,
      ws,
      "ws-half",
      RCS_SESSION_ID,
      pair.chatDoc,
      pair.sessionDoc,
      () =>
        condition === "missing"
          ? null
          : {
              chatDoc: pair.chatDoc,
              sessionDoc: { ...pair.sessionDoc, generation: "gen-new" },
            },
    );
    for (const [name, doc] of [
      [CHAT_DOC_NAME, pair.chatDoc],
      [SESSION_DOC_NAME, pair.sessionDoc],
    ] as const)
      noteInitialSyncDelivery(
        pending,
        "ws-half",
        name,
        GENERATION,
        broadcaster.sendDiff(ws, doc.ydoc, name, GENERATION, new Uint8Array()),
      );
    try {
      expect((await result).ok).toBe(false);
      expect(
        textFrames(ws)
          .map((frame) => JSON.parse(frame))
          .some((frame) => frame.type === "yjs:sync-complete"),
      ).toBe(false);
      expect(pending.size).toBe(0);
    } finally {
      pair.chatDoc.ydoc.destroy();
      pair.sessionDoc.ydoc.destroy();
    }
  });

  // 迟到差量收口时也要重新校验成对投影，不能复用失败通知发出前的代次检查。
  test("迟到恢复期间 Session 已换代时拒绝旧完成证明", async () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    const pair = docs();
    const pending = new Map<string, PendingInitialSync>();
    let changed = false;
    const result = synchronizeInitialDocs(
      pending,
      broadcaster,
      ws,
      "ws-late",
      RCS_SESSION_ID,
      pair.chatDoc,
      pair.sessionDoc,
      () => ({
        chatDoc: pair.chatDoc,
        sessionDoc: changed ? { ...pair.sessionDoc, generation: "gen-new" } : pair.sessionDoc,
      }),
    );
    ws.bufferedAmount = 65537;
    const failed = broadcaster.sendSnapshot(ws, pair.chatDoc.ydoc, CHAT_DOC_NAME, GENERATION);
    ws.bufferedAmount = 0;
    noteInitialSyncDelivery(pending, "ws-late", CHAT_DOC_NAME, GENERATION, failed);
    noteInitialSyncDelivery(
      pending,
      "ws-late",
      SESSION_DOC_NAME,
      GENERATION,
      broadcaster.sendSnapshot(ws, pair.sessionDoc.ydoc, SESSION_DOC_NAME, GENERATION),
    );
    try {
      expect((await result).ok).toBe(false);
      changed = true;
      noteInitialSyncDelivery(
        pending,
        "ws-late",
        CHAT_DOC_NAME,
        GENERATION,
        broadcaster.sendSnapshot(ws, pair.chatDoc.ydoc, CHAT_DOC_NAME, GENERATION),
      );
      expect(
        textFrames(ws)
          .map((frame) => JSON.parse(frame))
          .some((frame) => frame.type === "yjs:sync-complete"),
      ).toBe(false);
      expect(pending.size).toBe(0);
    } finally {
      pair.chatDoc.ydoc.destroy();
      pair.sessionDoc.ydoc.destroy();
    }
  });

  // 初始大快照中途被其他标签页换代时，只能证明新代完成，不能留下旧代缺失横幅。
  test("分片中途换代后重新握手当前投影，不报告旧代失败", async () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    broadcaster.enableFragmentSupport(ws);
    let current = docs("x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    const old = current;
    const pending = new Map<string, PendingInitialSync>();
    broadcaster.registerYjsDocListener(current.chatDoc.ydoc, CHAT_DOC_NAME, GENERATION);
    broadcaster.registerYjsDocListener(current.sessionDoc.ydoc, SESSION_DOC_NAME, GENERATION);
    const send = ws.send.bind(ws);
    let replaced = false;
    ws.send = (frame) => {
      send(frame);
      if (typeof frame === "string" && JSON.parse(frame).type === "yjs:sync-request") {
        queueMicrotask(() => {
          for (const [name, doc] of [
            [CHAT_DOC_NAME, current.chatDoc],
            [SESSION_DOC_NAME, current.sessionDoc],
          ] as const) {
            noteInitialSyncDelivery(
              pending,
              "ws-switch",
              name,
              doc.generation,
              broadcaster.sendDiff(ws, doc.ydoc, name, doc.generation, new Uint8Array()),
            );
          }
        });
        return;
      }
      if (!(frame instanceof Uint8Array) || replaced) return;
      replaced = true;
      queueMicrotask(() => {
        current = docs("y".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 2048));
        current.chatDoc.generation = "generation-new";
        current.sessionDoc.generation = "generation-new";
        broadcaster.registerYjsDocListener(current.chatDoc.ydoc, CHAT_DOC_NAME, "generation-new");
        broadcaster.registerYjsDocListener(current.sessionDoc.ydoc, SESSION_DOC_NAME, "generation-new");
        broadcaster.broadcastReplacement(current.chatDoc.ydoc, CHAT_DOC_NAME, "generation-new", true);
        broadcaster.broadcastReplacement(current.sessionDoc.ydoc, SESSION_DOC_NAME, "generation-new", true);
      });
    };
    try {
      const result = await synchronizeInitialDocs(
        pending,
        broadcaster,
        ws,
        "ws-switch",
        RCS_SESSION_ID,
        old.chatDoc,
        old.sessionDoc,
        () => current,
      );
      expect(result.ok).toBe(true);
      expect(incompleteFrames(ws)).toEqual([]);
      expect(
        textFrames(ws)
          .map((frame) => JSON.parse(frame))
          .filter((frame) => frame.type === "yjs:sync-complete"),
      ).toEqual([{ type: "yjs:sync-complete", docs: [CHAT_DOC_NAME, SESSION_DOC_NAME], generation: "generation-new" }]);
    } finally {
      broadcaster.cancelConnection(ws);
      broadcaster.unregisterYjsDocListener(CHAT_DOC_NAME);
      broadcaster.unregisterYjsDocListener(SESSION_DOC_NAME);
      for (const pair of [old, current]) {
        pair.chatDoc.ydoc.destroy();
        pair.sessionDoc.ydoc.destroy();
      }
    }
  });

  // 超过累计传输预算的快照仍须明确报告缺失，不能因支持分片而无界接收。
  test("超限文档未送达时返回失败并发送缺失状态", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    const { chatDoc, sessionDoc } = docs();
    chatDoc.ydoc.getText("big").insert(0, "x".repeat(MAX_YJS_TRANSFER_BYTES + 1));
    const pending = new Map<string, PendingInitialSync>();

    const resultPromise = synchronizeInitialDocs(pending, broadcaster, ws, "ws-1", RCS_SESSION_ID, chatDoc, sessionDoc);
    const entry = pending.get("ws-1");
    expect(entry).toBeDefined();

    const chatDelivery = broadcaster.sendDiff(ws, chatDoc.ydoc, CHAT_DOC_NAME, GENERATION, new Uint8Array());
    const sessionDelivery = broadcaster.sendDiff(ws, sessionDoc.ydoc, SESSION_DOC_NAME, GENERATION, new Uint8Array());
    expect(chatDelivery.ok).toBe(false);
    expect(sessionDelivery.ok).toBe(true);
    noteInitialSyncDelivery(pending, "ws-1", CHAT_DOC_NAME, GENERATION, chatDelivery);
    noteInitialSyncDelivery(pending, "ws-1", SESSION_DOC_NAME, GENERATION, sessionDelivery);

    const result = await resultPromise;
    expect(result).toEqual({ ok: false, failedDocNames: [CHAT_DOC_NAME] });
    expect(incompleteFrames(ws)).toEqual([
      {
        type: "yjs:history-incomplete",
        docs: [CHAT_DOC_NAME],
        reason: "too_large",
        bytes: chatDelivery.bytes,
        limitBytes: chatDelivery.limitBytes,
        generation: GENERATION,
      },
    ]);
  });

  // 两个文档都成功送达：同步结果为成功，不产生误导性的缺失状态。
  test("全部文档送达时返回成功且不发送缺失状态", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    const { chatDoc, sessionDoc } = docs();
    const pending = new Map<string, PendingInitialSync>();

    const resultPromise = synchronizeInitialDocs(pending, broadcaster, ws, "ws-1", RCS_SESSION_ID, chatDoc, sessionDoc);
    const chatDelivery = broadcaster.sendDiff(ws, chatDoc.ydoc, CHAT_DOC_NAME, GENERATION, new Uint8Array());
    const sessionDelivery = broadcaster.sendDiff(ws, sessionDoc.ydoc, SESSION_DOC_NAME, GENERATION, new Uint8Array());
    noteInitialSyncDelivery(pending, "ws-1", CHAT_DOC_NAME, GENERATION, chatDelivery);
    noteInitialSyncDelivery(pending, "ws-1", SESSION_DOC_NAME, GENERATION, sessionDelivery);

    const result = await resultPromise;
    expect(result).toEqual({ ok: true, failedDocNames: [] });
    expect(incompleteFrames(ws)).toEqual([]);
    // 显式成功标记让客户端能区分「本轮快照已交付」与「握手期间穿插的实时广播」。
    expect(
      textFrames(ws)
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame.type === "yjs:sync-complete"),
    ).toEqual([{ type: "yjs:sync-complete", docs: [CHAT_DOC_NAME, SESSION_DOC_NAME], generation: GENERATION }]);
  });

  // 握手超时后的全量兜底同样受累计传输预算约束。
  test("超时兜底的全量快照超限时返回失败", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    const { chatDoc, sessionDoc } = docs();
    chatDoc.ydoc.getText("big").insert(0, "x".repeat(MAX_YJS_TRANSFER_BYTES + 1));

    const result = await synchronizeInitialDocs(
      new Map<string, PendingInitialSync>(),
      broadcaster,
      ws,
      "ws-1",
      RCS_SESSION_ID,
      chatDoc,
      sessionDoc,
    );

    expect(result).toEqual({ ok: false, failedDocNames: [CHAT_DOC_NAME] });
    expect(incompleteFrames(ws).at(-1)?.docs).toEqual([CHAT_DOC_NAME]);
  });

  // 已成功交付大文档的差量时，另一文档超时不能把它重新按超限全量快照判成失败。
  test("部分差量已交付时超时只补齐剩余文档", async () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    const { chatDoc, sessionDoc } = docs();
    chatDoc.ydoc.getText("big").insert(0, "x".repeat(9 * 1024 * 1024));
    const cached = Y.encodeStateVector(chatDoc.ydoc);
    chatDoc.ydoc.getText("big").insert(0, "tail");
    const pending = new Map<string, PendingInitialSync>();
    const result = synchronizeInitialDocs(pending, broadcaster, ws, "ws-1", RCS_SESSION_ID, chatDoc, sessionDoc);
    noteInitialSyncDelivery(
      pending,
      "ws-1",
      CHAT_DOC_NAME,
      GENERATION,
      broadcaster.sendDiff(ws, chatDoc.ydoc, CHAT_DOC_NAME, GENERATION, cached),
    );
    expect(await result).toEqual({ ok: true, failedDocNames: [] });
    expect(incompleteFrames(ws)).toEqual([]);
    expect(pending.size).toBe(0);
  });

  // 大差量已写入 socket 后触发背压，完成证明仍须排在它之后，普通控制帧继续受限。
  test("差量造成背压时同步结果仍有界交付", async () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    const send = ws.send.bind(ws);
    ws.send = (frame) => {
      send(frame);
      ws.bufferedAmount = (ws.bufferedAmount ?? 0) + (typeof frame === "string" ? frame.length : frame.byteLength);
    };
    const { chatDoc, sessionDoc } = docs("x".repeat(70_000));
    const pending = new Map<string, PendingInitialSync>();
    const result = synchronizeInitialDocs(pending, broadcaster, ws, "ws-1", RCS_SESSION_ID, chatDoc, sessionDoc);
    for (const [docName, doc] of [
      [SESSION_DOC_NAME, sessionDoc],
      [CHAT_DOC_NAME, chatDoc],
    ] as const) {
      noteInitialSyncDelivery(
        pending,
        "ws-1",
        docName,
        GENERATION,
        broadcaster.sendDiff(ws, doc.ydoc, docName, GENERATION, new Uint8Array()),
      );
    }
    expect(await result).toEqual({ ok: true, failedDocNames: [] });
    expect((ws.bufferedAmount ?? 0) > 64 * 1024).toBe(true);
    expect(textFrames(ws).map((frame) => JSON.parse(frame).type)).toContain("yjs:sync-complete");
    expect(pending.size).toBe(0);
    expect(broadcaster.sendToYjsWs(ws, { type: "keep_alive" })).toBe(false);
  });

  // 背压不能吞掉缺失通知；同连接恢复后也不能把发送异常误报为同步成功。
  test("失败通知越过差量背压，完成通知异常明确关闭连接", async () => {
    const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
    const ws = createWs();
    const { chatDoc, sessionDoc } = docs();
    const pending = new Map<string, PendingInitialSync>();
    const result = synchronizeInitialDocs(pending, broadcaster, ws, "ws-1", RCS_SESSION_ID, chatDoc, sessionDoc);
    ws.bufferedAmount = 70_000;
    for (const name of [CHAT_DOC_NAME, SESSION_DOC_NAME]) {
      noteInitialSyncDelivery(pending, "ws-1", name, GENERATION, {
        ok: false,
        bytes: 70_000,
        limitBytes: 8 * 1024 * 1024,
        reason: "backpressure",
      });
    }
    expect((await result).ok).toBe(false);
    expect(incompleteFrames(ws)).toHaveLength(1);
    ws.send = () => {
      throw new Error("socket send failed");
    };
    for (const name of [CHAT_DOC_NAME, SESSION_DOC_NAME]) {
      noteInitialSyncDelivery(pending, "ws-1", name, GENERATION, {
        ok: true,
        bytes: 1,
        limitBytes: 8 * 1024 * 1024,
        reason: null,
      });
    }
    expect(pending.size).toBe(1);
    expect(ws.closed).toEqual([[1013, "initial sync status delivery failed"]]);
    pending.get("ws-1")?.resolve();
    pending.clear();
  });
});
