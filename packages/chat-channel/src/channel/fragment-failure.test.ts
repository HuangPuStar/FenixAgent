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
  return (delay: number) => {
    const timer = scheduled.find((entry) => !entry.cleared && entry.delay === delay);
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
