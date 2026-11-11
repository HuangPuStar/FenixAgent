import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { MAX_YJS_SYNC_PAYLOAD_BYTES } from "../protocol/update-frame";
import { BroadcastRecovery } from "./broadcast-recovery";
import { createWs } from "./connection-test-helpers";
import { deliveredLegacyFrame, rejectedLegacyFrame } from "./fragment-delivery";

const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
afterEach(() => {
  if (originalSetTimeout) Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
  if (originalClearTimeout) Object.defineProperty(globalThis, "clearTimeout", originalClearTimeout);
});

/** 控制容量重查窗口，检查末次更新也能触发恢复且不产生周期性空转。 */
function capacityTimers() {
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void) => {
      const timer = { callback, cleared: false };
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
  return {
    pending: () => timers.filter((timer) => !timer.cleared).length,
    run: () => {
      for (const timer of timers.filter((entry) => !entry.cleared)) {
        timer.cleared = true;
        timer.callback();
      }
    },
  };
}

/** 使用真实超限文档，计量取得快照的次数并验证接收端补齐完整基线。 */
function setup() {
  const source = new Y.Doc();
  source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  const peers = [createWs(), createWs()];
  const restored = new Map(peers.map((peer) => [peer, new Y.Doc()]));
  let reads = 0;
  const name = "chat:rcs-capacity";
  const recovery = new BroadcastRecovery({
    document: () => {
      reads += 1;
      return { ydoc: source, generation: "gen-one" };
    },
    deliver: (ws, _name, _generation, update) => {
      if (update.length > MAX_YJS_SYNC_PAYLOAD_BYTES) return rejectedLegacyFrame(update.length, "too_large");
      Y.applyUpdate(restored.get(ws)!, update);
      return deliveredLegacyFrame(update.length);
    },
    pending: () => false,
    buffered: (ws) => ws.bufferedAmount ?? 0,
  });
  for (const peer of peers)
    recovery.rejected(peer, name, "gen-one", rejectedLegacyFrame(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024, "too_large"));
  reads = 0;
  return {
    source,
    peers,
    restored,
    name,
    recovery,
    reads: () => reads,
    cleanup: () => {
      for (const peer of peers) recovery.forgetConnection(peer);
      source.destroy();
      for (const doc of restored.values()) doc.destroy();
    },
  };
}

// 流式回复可产生数百次小更新，同一文档所有阻塞连接须共用一次容量重查。
test("超限容量重查按文档合并，最后一次收缩仍会恢复基线", () => {
  const timers = capacityTimers();
  const state = setup();
  try {
    for (let update = 0; update < 100; update += 1) {
      for (const peer of state.peers) expect(state.recovery.retryBlocked(peer, state.name)).toBe(true);
      state.recovery.reconcile();
    }
    expect(state.reads()).toBe(0);
    expect(timers.pending()).toBe(1);
    timers.run();
    expect(state.reads()).toBe(1);
    expect(timers.pending()).toBe(0);
    state.peers[0].bufferedAmount = 65537;
    for (const peer of state.peers) state.recovery.retryBlocked(peer, state.name);
    timers.run();
    expect(state.reads()).toBe(2);
    expect(state.peers.flatMap((peer) => peer.closed)).toEqual([]);
    state.source.transact(() => {
      const history = state.source.getText("history");
      history.delete(0, history.length);
      state.source.getMap("data").set("title", "recovered");
    });
    state.peers[0].bufferedAmount = 0;
    for (const peer of state.peers) state.recovery.retryBlocked(peer, state.name);
    timers.run();
    for (const doc of state.restored.values()) expect(doc.getMap("data").get("title")).toBe("recovered");
    expect(timers.pending()).toBe(0);
  } finally {
    state.cleanup();
  }
});

// 换代或最后一个连接释放后，重查任务不能继续持有文档并执行全量编码。
test.each(["document", "connections"] as const)("%s 释放会清理等待的容量重查", (target) => {
  const timers = capacityTimers();
  const state = setup();
  try {
    for (const peer of state.peers) state.recovery.retryBlocked(peer, state.name);
    expect(timers.pending()).toBe(1);
    if (target === "document") state.recovery.forgetDocument(state.name);
    else for (const peer of state.peers) state.recovery.forgetConnection(peer);
    expect(timers.pending()).toBe(0);
    timers.run();
    expect(state.reads()).toBe(0);
  } finally {
    state.cleanup();
  }
});
