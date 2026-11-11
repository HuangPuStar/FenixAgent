import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { decodeYjsSyncFrame, MAX_YJS_SYNC_PAYLOAD_BYTES, MAX_YJS_TRANSFER_BYTES } from "../protocol/update-frame";
import { YjsFragmentReceiver } from "../transport/update-fragments";
import { type LegacyFrameDelivery, YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createWs } from "./connection-test-helpers";
import { noteInitialSyncDelivery, type PendingInitialSync, synchronizeInitialDocs } from "./gateway-sync";

const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
afterEach(() => {
  if (originalSetTimeout) Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
  if (originalClearTimeout) Object.defineProperty(globalThis, "clearTimeout", originalClearTimeout);
});

/** 分开推进容量检查、逐片交付和超时，保留真实 Promise 的完成顺序。 */
function installTimers() {
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (timer: (typeof timers)[number]) => {
      if (timer) timer.cleared = true;
    },
  });
  return (delay: number) => {
    const timer = timers.find((entry) => !entry.cleared && entry.delay === delay);
    if (!timer) return false;
    timer.cleared = true;
    timer.callback();
    return true;
  };
}

/** 让广播批次、发送完成、等待重试与恢复通知依次收口。 */
async function flush(): Promise<void> {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

/** 用真实 Yjs 接收端记录通知时实际可见的数据，不能只验证服务端派发。 */
function setup(fragments = true) {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  const restored = new Y.Doc();
  const ws = createWs();
  const receiver = new YjsFragmentReceiver(() => {});
  const name = "chat:rcs-follow-up";
  const notifications: unknown[] = [];
  ws.send = (data) => {
    ws.messages.push(data);
    if (typeof data === "string") return;
    const decoded = decodeYjsSyncFrame(data);
    const frame = decoded?.type === "fragment" ? receiver.accept(decoded) : decoded;
    if (frame?.type === "update") Y.applyUpdate(restored, frame.update);
  };
  registry.addClient("ws-follow-up", createClient({ ws, rcsSessionId: "rcs-follow-up" }));
  if (fragments) broadcaster.enableFragmentSupport(ws);
  return {
    broadcaster,
    source,
    restored,
    ws,
    name,
    notifications,
    onRecovered: (delivery: LegacyFrameDelivery) => {
      expect(delivery.ok).toBe(true);
      notifications.push(restored.getMap("data").get("title"));
    },
    register: () => broadcaster.registerYjsDocListener(source, name, "gen-one"),
    cleanup: () => {
      broadcaster.cancelConnection(ws);
      broadcaster.unregisterYjsDocListener(name);
      receiver.reset();
      source.destroy();
      restored.destroy();
    },
  };
}

// 第一轮基线完成后还有排水、后继分片或容量阻塞时，不能提前证明当前历史已恢复。
test.each([
  "fragmented",
  "congested",
  "oversized",
] as const)("恢复期间的 %s 后继数据必须先于完成通知", async (followup) => {
  const run = installTimers();
  const state = setup();
  const { source, restored, broadcaster, ws, name, notifications, onRecovered } = state;
  try {
    const history = source.getText("history");
    history.insert(0, "x".repeat(MAX_YJS_TRANSFER_BYTES + 1024));
    source.getMap("data").set("title", "before");
    state.register();
    expect(broadcaster.sendSnapshot(ws, source, name, "gen-one", onRecovered).reason).toBe("too_large");
    history.delete(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024, history.length - MAX_YJS_SYNC_PAYLOAD_BYTES - 1024);
    await flush();
    run(1_000);
    run(0);
    source.getMap("data").set("title", "during");
    if (followup === "fragmented") history.insert(0, "y".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    if (followup === "oversized") history.insert(0, "y".repeat(MAX_YJS_TRANSFER_BYTES));
    await flush();
    for (let step = 0; step < 10 && restored.getMap("data").get("title") !== "before"; step += 1) {
      run(0);
      if (followup === "congested" && restored.getMap("data").get("title") === "before") ws.bufferedAmount = 65537;
      await flush();
    }
    expect(restored.getMap("data").get("title")).toBe("before");
    expect(notifications).toEqual([]);
    if (followup === "oversized") {
      history.delete(0, MAX_YJS_TRANSFER_BYTES);
      await flush();
      run(1_000);
    }
    ws.bufferedAmount = 0;
    broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
    for (let step = 0; step < 10 && notifications.length === 0; step += 1) {
      run(0);
      await flush();
    }
    expect(notifications).toEqual(["during"]);
    expect(ws.closed).toEqual([]);
  } finally {
    state.cleanup();
  }
});

// 普通定向帧被背压拒绝后，补发完整基线必须通知初始同步解除失败状态。
test.each(["snapshot", "diff"] as const)("定向 %s 的即时背压失败恢复后会通知", async (path) => {
  const state = setup(false);
  const { source, broadcaster, ws, name, notifications, onRecovered } = state;
  try {
    source.getMap("data").set("title", "recovered");
    state.register();
    ws.bufferedAmount = 65537;
    const result =
      path === "snapshot"
        ? broadcaster.sendSnapshot(ws, source, name, "gen-one", onRecovered)
        : broadcaster.sendDiff(ws, source, name, "gen-one", new Uint8Array(), onRecovered);
    expect(result.reason).toBe("backpressure");
    expect(notifications).toEqual([]);
    ws.bufferedAmount = 0;
    broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
    await flush();
    expect(notifications).toEqual(["recovered"]);
  } finally {
    state.cleanup();
  }
});

// 零分片超时及等待旧基线失败也属于最终拒绝，后续恢复不能丢失初始同步的观察者。
test.each(["snapshot", "diff", "deferred"] as const)("定向 %s 的异步背压失败恢复后会通知", async (path) => {
  const run = installTimers();
  const state = setup();
  const { source, broadcaster, ws, name, notifications, onRecovered } = state;
  try {
    source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    source.getMap("data").set("title", "recovered");
    state.register();
    ws.bufferedAmount = 65537;
    if (path === "deferred") broadcaster.sendSnapshot(ws, source, name, "gen-one");
    const result =
      path === "snapshot"
        ? broadcaster.sendSnapshot(ws, source, name, "gen-one", onRecovered)
        : broadcaster.sendDiff(ws, source, name, "gen-one", new Uint8Array(), onRecovered);
    expect(result.reason).toBeNull();
    expect(notifications).toEqual([]);
    run(30_000);
    expect((await result.completion)?.reason).toBe("backpressure");
    ws.bufferedAmount = 0;
    broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
    for (let step = 0; step < 10 && notifications.length === 0; step += 1) {
      run(0);
      await flush();
    }
    expect(notifications).toEqual(["recovered"]);
    expect(ws.closed).toEqual([]);
  } finally {
    state.cleanup();
  }
});

// 在途不是失败，正常首轮分片完成不能再补发一份恢复快照或触发失败恢复回调。
test("正常定向分片完成不登记失败恢复", async () => {
  const run = installTimers();
  const state = setup();
  const { source, broadcaster, ws, name, notifications, onRecovered } = state;
  try {
    source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    source.getMap("data").set("title", "first delivery");
    state.register();
    const result = broadcaster.sendSnapshot(ws, source, name, "gen-one", onRecovered);
    expect(result.reason).toBeNull();
    for (let step = 0; step < 12; step += 1) {
      run(0);
      await flush();
    }
    expect((await result.completion)?.ok).toBe(true);
    broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
    await flush();
    expect(notifications).toEqual([]);
    const transfers = ws.messages.flatMap((data) => {
      if (typeof data === "string") return [];
      const frame = decodeYjsSyncFrame(data);
      return frame?.type === "fragment" ? [frame.transferId] : [];
    });
    expect(new Set(transfers).size).toBe(1);
  } finally {
    state.cleanup();
  }
});

// 首次同步也必须尊重同文档的后继容量阻塞，不能因首轮成功就显示历史完整。
test.each([
  "state-vector",
  "snapshot",
] as const)("首次 %s 分片期间增长超限时保留缺失状态，缩小后补齐证明", async (path) => {
  const run = installTimers();
  const state = setup();
  const { source, restored, broadcaster, ws, name } = state;
  const session = new Y.Doc();
  const pending = new Map<string, PendingInitialSync>();
  const proofs: unknown[] = [];
  const originalSend = ws.send;
  const sessionName = "session:rcs-follow-up";
  const record = (docName: string, delivery: LegacyFrameDelivery) =>
    noteInitialSyncDelivery(pending, "ws-follow-up", docName, "gen-one", delivery);
  ws.send = (data) => {
    originalSend(data);
    if (typeof data !== "string") return;
    const frame = JSON.parse(data);
    if (frame.type === "yjs:sync-complete") proofs.push(restored.getMap("data").get("title"));
    if (frame.type === "yjs:sync-request" && path === "state-vector")
      for (const docName of [name, sessionName])
        record(
          docName,
          broadcaster.sendDiff(
            ws,
            docName === name ? source : session,
            docName,
            "gen-one",
            new Uint8Array(),
            (result) => record(docName, result),
          ),
        );
  };
  try {
    const history = source.getText("history");
    history.insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    source.getMap("data").set("title", "before");
    state.register();
    broadcaster.registerYjsDocListener(session, sessionName, "gen-one");
    const initial = synchronizeInitialDocs(
      pending,
      broadcaster,
      ws,
      "ws-follow-up",
      "rcs-follow-up",
      { ydoc: source, generation: "gen-one" },
      { ydoc: session, generation: "gen-one" },
    );
    if (path === "snapshot") run(500);
    await flush();
    run(0);
    source.transact(() => {
      history.insert(0, "y".repeat(MAX_YJS_TRANSFER_BYTES));
      source.getMap("data").set("title", "during");
    });
    await flush();
    for (let step = 0; step < 10 && restored.getMap("data").get("title") !== "before"; step += 1) {
      run(0);
      await flush();
    }
    expect((await initial).ok).toBe(false);
    expect(proofs).toEqual([]);
    history.delete(0, MAX_YJS_TRANSFER_BYTES);
    await flush();
    run(1_000);
    for (let step = 0; step < 10 && proofs.length === 0; step += 1) {
      run(0);
      await flush();
    }
    expect(proofs).toEqual(["during"]);
    expect(pending.size).toBe(0);
    expect(ws.closed).toEqual([]);
  } finally {
    pending.clear();
    broadcaster.unregisterYjsDocListener(sessionName);
    state.cleanup();
    session.destroy();
  }
});

// 已有客户端状态与初始差量共同构成基线，不能只从差量提取向量后重复传输整个历史。
test("大差量的固定同步边界复用客户端已有状态", async () => {
  const run = installTimers();
  const state = setup();
  const { source, restored, broadcaster, ws, name } = state;
  try {
    source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));
    const vector = Y.encodeStateVector(restored);
    source.getText("history").insert(0, "y".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    state.register();
    const delivery = broadcaster.sendDiff(ws, source, name, "gen-one", vector);
    run(0);
    source.getMap("data").set("title", "included in boundary");
    await flush();
    for (let step = 0; step < 10; step += 1) {
      run(0);
      await flush();
    }
    expect((await delivery.completion)?.ok).toBe(true);
    expect(restored.getText("history").toString()).toBe(source.getText("history").toString());
    expect(restored.getMap("data").get("title")).toBe("included in boundary");
    const transfers = ws.messages.flatMap((data) => {
      if (typeof data === "string") return [];
      const frame = decodeYjsSyncFrame(data);
      return frame?.type === "fragment" ? [frame.transferId] : [];
    });
    expect(new Set(transfers).size).toBe(1);
  } finally {
    state.cleanup();
  }
});

// 纯删除不改变 state vector，但 delete set 仍属于基线后的固定同步边界。
test("分片期间的纯删除也会在完成前交付", async () => {
  const run = installTimers();
  const state = setup();
  const { source, restored, broadcaster, ws, name } = state;
  try {
    const history = source.getText("history");
    history.insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    state.register();
    const delivery = broadcaster.sendSnapshot(ws, source, name, "gen-one");
    run(0);
    history.delete(0, history.length);
    await flush();
    for (let step = 0; step < 10; step += 1) {
      run(0);
      await flush();
    }
    expect((await delivery.completion)?.ok).toBe(true);
    expect(restored.getText("history").length).toBe(0);
  } finally {
    state.cleanup();
  }
});

// 末片发送后缓冲区尚未排空属于正常过程，小差量须等待排水并沿用整轮总期限。
test.each(["drain", "deadline"] as const)("固定差量等待末片排水，%s 后正确收口", async (finish) => {
  const run = installTimers();
  const state = setup();
  const { source, restored, broadcaster, ws, name } = state;
  const send = ws.send;
  const close = ws.close.bind(ws);
  ws.send = (data) => {
    send(data);
    if (typeof data === "string") return;
    const frame = decodeYjsSyncFrame(data);
    if (frame?.type === "fragment" && frame.offset + frame.chunk.length === frame.totalBytes) ws.bufferedAmount = 65537;
  };
  ws.close = (code, reason) => {
    close(code, reason);
    Object.defineProperty(ws, "readyState", { value: 3 });
  };
  let completed: LegacyFrameDelivery | undefined;
  try {
    source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    source.getMap("data").set("title", "before");
    state.register();
    const delivery = broadcaster.sendSnapshot(ws, source, name, "gen-one");
    void delivery.completion?.then((result) => {
      completed = result;
    });
    run(0);
    source.getMap("data").set("title", "fixed difference");
    await flush();
    for (let step = 0; step < 10 && restored.getMap("data").get("title") !== "before"; step += 1) {
      run(0);
      await flush();
    }
    expect(completed).toBeUndefined();
    if (finish === "drain") {
      ws.bufferedAmount = 0;
      run(0);
      await flush();
      expect(completed?.ok).toBe(true);
      expect(restored.getMap("data").get("title")).toBe("fixed difference");
      expect(ws.closed).toEqual([]);
    } else {
      run(30_000);
      await flush();
      expect(completed?.ok).toBe(false);
      expect(ws.closed[0]?.[0]).toBe(1013);
      expect(run(0)).toBe(false);
    }
  } finally {
    state.cleanup();
  }
});
