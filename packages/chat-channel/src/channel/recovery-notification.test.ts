import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { BroadcastRecovery } from "./broadcast-recovery";
import { createWs, deferred } from "./connection-test-helpers";
import { deliveredLegacyFrame, type LegacyFrameDelivery, rejectedLegacyFrame } from "./fragment-delivery";

const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
afterEach(() => {
  if (originalSetTimeout) Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
  if (originalClearTimeout) Object.defineProperty(globalThis, "clearTimeout", originalClearTimeout);
});

/** 手动触发容量检查，分开控制已派发、完成交付和完成证明的时序。 */
function setup() {
  const timers = new Set<{ callback: () => void }>();
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void) => {
      const timer = { callback };
      timers.add(timer);
      return timer;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (timer: { callback: () => void }) => timers.delete(timer),
  });
  const ydoc = new Y.Doc();
  ydoc.getMap("data").set("title", "small now");
  const projection = { ydoc, generation: "gen-one" };
  const first = deferred<LegacyFrameDelivery>();
  let deliveries = 0;
  const recovery = new BroadcastRecovery({
    document: () => projection,
    deliver: () =>
      deliveries++ === 0
        ? { ...rejectedLegacyFrame(1, "backpressure"), completion: first.promise }
        : deliveredLegacyFrame(1),
    pending: () => false,
    buffered: () => 0,
  });
  const ws = createWs();
  const name = "chat:rcs-proof";
  const old: LegacyFrameDelivery[] = [];
  recovery.rejected(ws, name, "gen-one", rejectedLegacyFrame(10_000_000, "too_large"), (result) => old.push(result));
  return {
    recovery,
    ws,
    name,
    old,
    projection,
    first,
    run: () => {
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer.callback();
      }
    },
    cleanup: () => {
      recovery.forgetConnection(ws);
      ydoc.destroy();
    },
  };
}

// 分片派发并未交付；失败后保留恢复证明，只有最终成功才能解除门禁。
test("恢复分片失败后继续追赶，完整交付前不发完成通知", async () => {
  const state = setup();
  try {
    state.run();
    expect(state.old).toEqual([]);
    state.first.resolve(rejectedLegacyFrame(1, "backpressure"));
    await Promise.resolve();
    expect(state.old).toEqual([]);
    state.recovery.reconcile();
    await Promise.resolve();
    expect(state.old).toHaveLength(1);
    expect(state.old[0]?.ok).toBe(true);
  } finally {
    state.cleanup();
  }
});

// 旧恢复的迟到成功不能跨越文档、连接、代次或同文档新请求，结算后继同步证明。
test.each(["document", "connection", "generation", "request"] as const)("%s 更新会使旧恢复通知失效", async (change) => {
  const state = setup();
  const current: LegacyFrameDelivery[] = [];
  try {
    state.run();
    if (change === "document") state.recovery.forgetDocument(state.name);
    if (change === "connection") state.recovery.forgetConnection(state.ws);
    if (change === "generation") state.projection.generation = "gen-new";
    state.recovery.rejected(
      state.ws,
      state.name,
      state.projection.generation,
      rejectedLegacyFrame(10_000_000, "too_large"),
      (result) => current.push(result),
    );
    state.first.resolve(deliveredLegacyFrame(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.old).toEqual([]);
    expect(current).toEqual([]);
    state.run();
    await Promise.resolve();
    expect(current).toHaveLength(1);
    expect(state.old).toEqual([]);
  } finally {
    state.cleanup();
  }
});

// 通知已入微任务队列后仍可能被换代撤销，不能仅在分片完成回调里检查一次身份。
test("完成通知入队后注销文档仍可撤销证明", async () => {
  const state = setup();
  try {
    state.run();
    state.first.resolve(deliveredLegacyFrame(1));
    await Promise.resolve();
    state.recovery.forgetDocument(state.name);
    await Promise.resolve();
    expect(state.old).toEqual([]);
  } finally {
    state.cleanup();
  }
});
