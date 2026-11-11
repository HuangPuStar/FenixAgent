import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { decodeYjsSyncFrame, MAX_YJS_SYNC_PAYLOAD_BYTES } from "../protocol/update-frame";
import { YjsFragmentReceiver } from "../transport/update-fragments";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient } from "./connection-test-helpers";
import type { WsConnection } from "./connection-types";

const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
afterEach(() => {
  if (originalSetTimeout) Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
  if (originalClearTimeout) Object.defineProperty(globalThis, "clearTimeout", originalClearTimeout);
});

/** 只推进指定阶段，重现服务端超时早于接收端组装超时的顺序。 */
function timers() {
  const scheduled: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void, delay: number) => {
      const timer = { callback, delay, cleared: false };
      scheduled.push(timer);
      return timer;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (timer: (typeof scheduled)[number]) => {
      if (timer) timer.cleared = true;
    },
  });
  return (delay: number, last = false) => {
    const matches = scheduled.filter((entry) => !entry.cleared && entry.delay === delay);
    const timer = last ? matches.at(-1) : matches[0];
    if (!timer) throw new Error(`Missing timer ${delay}`);
    timer.cleared = true;
    timer.callback();
  };
}

// 半成品更新不能直接另起传输重试；服务端必须先关闭，让新 socket 从干净组装状态恢复。
test.each(["deadline", "send"] as const)("部分分片已交付后 %s 失败会先关闭连接", async (failure) => {
  const runTimer = timers();
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  const name = "chat:rcs-partial";
  const receiver = new YjsFragmentReceiver(() => {});
  const closes: number[] = [];
  let sent = 0;
  const socket: WsConnection & { readyState: number; bufferedAmount: number } = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data) => {
      if (typeof data === "string") return;
      if (sent > 0 && failure === "send") throw new Error("simulated write failure");
      const frame = decodeYjsSyncFrame(data);
      if (frame?.type === "fragment") receiver.accept(frame);
      sent += 1;
      if (failure === "deadline") socket.bufferedAmount = 65537;
    },
    close: (code) => {
      closes.push(code ?? 1000);
      socket.readyState = 3;
      receiver.reset();
    },
  };
  registry.addClient("ws-partial", createClient({ ws: socket, rcsSessionId: "rcs-partial" }));
  broadcaster.enableFragmentSupport(socket);
  broadcaster.registerYjsDocListener(source, name, "gen-one");
  try {
    const delivery = broadcaster.sendSnapshot(socket, source, name, "gen-one");
    runTimer(0);
    expect(receiver.hasPending(name)).toBe(true);
    source.getMap("data").set("late", true);
    await Promise.resolve();
    runTimer(failure === "deadline" ? 30_000 : 0);
    expect((await delivery.completion)?.ok).toBe(false);
    expect(closes).toEqual([1013]);
    expect(receiver.hasPending(name)).toBe(false);
    socket.bufferedAmount = 0;
    expect(broadcaster.sendToYjsWs(socket, { type: "keep_alive" })).toBe(false);
    expect(sent).toBe(1);
  } finally {
    broadcaster.cancelConnection(socket);
    broadcaster.unregisterYjsDocListener(name);
    receiver.reset();
    source.destroy();
  }
});

// 生产换代先注销旧监听；替换失败仍必须关闭，不能留下已取消分片的接收端组装。
test.each([
  "backpressure",
  "forced-send",
  "fragment-send",
  "fragment-timeout",
] as const)("换代替换 %s 失败后关闭连接并清除旧分片", async (failure) => {
  const runTimer = timers();
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  const next = new Y.Doc();
  source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  next
    .getText("history")
    .insert(0, failure.startsWith("fragment") ? "y".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024) : "new");
  const name = "chat:rcs-canceled";
  const receiver = new YjsFragmentReceiver(() => {});
  const closes: number[] = [];
  let sent = 0;
  let rejectSend = false;
  const socket: WsConnection & { readyState: number; bufferedAmount: number } = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data) => {
      if (rejectSend) throw new Error("simulated replacement write failure");
      if (typeof data === "string") return;
      const frame = decodeYjsSyncFrame(data);
      if (frame?.type === "fragment") receiver.accept(frame);
      sent += 1;
    },
    close: (code) => {
      closes.push(code ?? 1000);
      socket.readyState = 3;
      receiver.reset();
    },
  };
  registry.addClient("ws-canceled", createClient({ ws: socket, rcsSessionId: "rcs-canceled" }));
  broadcaster.enableFragmentSupport(socket);
  broadcaster.registerYjsDocListener(source, name, "gen-old");
  try {
    broadcaster.broadcastSnapshot(source, name, "gen-old");
    runTimer(0);
    expect(receiver.hasPending(name)).toBe(true);
    broadcaster.registerYjsDocListener(next, name, "gen-new");
    socket.bufferedAmount = failure === "backpressure" || failure === "fragment-timeout" ? 65537 : 0;
    rejectSend = failure.endsWith("send");
    broadcaster.broadcastReplacement(next, name, "gen-new", failure === "forced-send");
    if (failure === "fragment-send") runTimer(0);
    if (failure === "fragment-timeout") runTimer(30_000, true);
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    expect(closes).toEqual([1013]);
    expect(receiver.hasPending(name)).toBe(false);
    expect(sent).toBe(1);
  } finally {
    broadcaster.cancelConnection(socket);
    broadcaster.unregisterYjsDocListener(name);
    receiver.reset();
    source.destroy();
    next.destroy();
  }
});

// 两轮权威换代之间取消旧 replace 属于预期收口，旧回调不能关闭已经收到新投影的连接。
test("旧代大 replace 取消后不关闭已成功换代的连接", async () => {
  const runTimer = timers();
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const old = new Y.Doc();
  const next = new Y.Doc();
  const restored = new Y.Doc();
  old.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  next.getMap("data").set("title", "current");
  const name = "chat:rcs-superseded";
  const receiver = new YjsFragmentReceiver(() => {});
  const closes: number[] = [];
  const socket: WsConnection = {
    readyState: 1,
    send: (data) => {
      if (typeof data === "string") return;
      const frame = decodeYjsSyncFrame(data);
      if (frame?.type === "fragment") receiver.accept(frame);
      if (frame?.type === "replace") {
        receiver.cancel(name);
        Y.applyUpdate(restored, frame.update);
      }
    },
    close: (code) => closes.push(code ?? 1000),
  };
  registry.addClient("ws-superseded", createClient({ ws: socket, rcsSessionId: "rcs-superseded" }));
  broadcaster.enableFragmentSupport(socket);
  broadcaster.registerYjsDocListener(old, name, "gen-old");
  try {
    broadcaster.broadcastReplacement(old, name, "gen-old");
    runTimer(0);
    expect(receiver.hasPending(name)).toBe(true);
    broadcaster.registerYjsDocListener(next, name, "gen-new");
    broadcaster.broadcastReplacement(next, name, "gen-new", true);
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    expect(closes).toEqual([]);
    expect(receiver.hasPending(name)).toBe(false);
    expect(restored.getMap("data").get("title")).toBe("current");
  } finally {
    broadcaster.cancelConnection(socket);
    broadcaster.unregisterYjsDocListener(name);
    receiver.reset();
    for (const doc of [old, next, restored]) doc.destroy();
  }
});
