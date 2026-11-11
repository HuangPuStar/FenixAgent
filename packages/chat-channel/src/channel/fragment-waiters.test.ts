import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  encodeYjsStateVectorFrame,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  MAX_YJS_TRANSFER_BYTES,
} from "../protocol/update-frame";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createGateway, createRelayEvents, createWs } from "./connection-test-helpers";
import {
  deliveredLegacyFrame,
  type LegacyFrameDelivery,
  rejectedLegacyFrame,
  YjsFragmentSender,
} from "./fragment-delivery";

const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
afterEach(() => {
  if (originalSetTimeout) Object.defineProperty(globalThis, "setTimeout", originalSetTimeout);
  if (originalClearTimeout) Object.defineProperty(globalThis, "clearTimeout", originalClearTimeout);
});

/** 阻塞发送泵，计量等待请求实际持有的计时器。 */
function holdTimers() {
  const active = new Map<object, number>();
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (_callback: () => void, delay: number) => {
      const timer = {};
      active.set(timer, delay);
      return timer;
    },
  });
  Object.defineProperty(globalThis, "clearTimeout", {
    configurable: true,
    value: (timer: object) => active.delete(timer),
  });
  return (delay?: number) => [...active.values()].filter((value) => delay === undefined || value === delay).length;
}

// 重复 state-vector 不能为同一个在途文档逐次保留向量、完成回调及 30 秒计时器。
test("网关重复大向量共享同一等待任务，断开立即清理", async () => {
  const timerCount = holdTimers();
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const doc = new Y.Doc();
  doc.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  const name = "chat:rcs-1";
  const ws = createWs(65537);
  registry.addClient("ws-repeat", createClient({ ws }));
  const gateway = createGateway(
    registry,
    broadcaster,
    createRelayEvents(registry, broadcaster, []),
    {},
    {
      getChat: () => ({ ydoc: doc, generation: "gen-one" }),
    },
  );
  const deliveries: LegacyFrameDelivery[] = [];
  const sendDiff = broadcaster.sendDiff.bind(broadcaster);
  broadcaster.sendDiff = (...args) => {
    const result = sendDiff(...args);
    deliveries.push(result);
    return result;
  };
  broadcaster.enableFragmentSupport(ws);
  try {
    broadcaster.sendSnapshot(ws, doc, name, "gen-one");
    const frame = encodeYjsStateVectorFrame(name, "gen-one", new Uint8Array(MAX_YJS_SYNC_PAYLOAD_BYTES));
    for (let request = 0; request < 12; request += 1) await gateway.handleMessage(ws, "ws-repeat", frame);
    expect(deliveries).toHaveLength(12);
    expect(deliveries.every((delivery) => delivery.completion !== undefined)).toBe(true);
    expect(new Set(deliveries.map((delivery) => delivery.completion)).size).toBe(1);
    expect(timerCount(30_000)).toBe(2);
    expect(ws.closed).toEqual([]);
    gateway.handleClose("ws-repeat");
    expect(timerCount()).toBe(0);
    expect((await deliveries[0]!.completion)?.ok).toBe(false);
  } finally {
    gateway.handleClose("ws-repeat");
    doc.destroy();
  }
});

// 被等待任务保留的向量也占在途预算，不能在已有 60 MiB 传输上继续挂 8 MiB 向量。
test("等待向量与发送载荷共用 64 MiB 连接预算", async () => {
  holdTimers();
  const sender = new YjsFragmentSender(() => {});
  const ws = createWs(65537);
  let expired = false;
  sender.send(ws, "chat:rcs-one", "gen-one", "update", new Uint8Array(MAX_YJS_TRANSFER_BYTES - 4 * 1024 * 1024));
  try {
    const waiting = sender.afterPending(
      ws,
      "chat:rcs-one",
      () => deliveredLegacyFrame(0),
      () => {
        expired = true;
        sender.cancelConnection(ws);
        return rejectedLegacyFrame(0, "backpressure");
      },
      () => rejectedLegacyFrame(0, "encode_failed"),
      MAX_YJS_SYNC_PAYLOAD_BYTES,
    );
    expect(expired).toBe(true);
    expect((await waiting)?.ok).toBe(false);
    expect(sender.hasWaiter(ws, "chat:rcs-one")).toBe(false);
  } finally {
    sender.cancelConnection(ws);
  }
});

// 新传输也必须看到已保留的等待向量，预算不能只在创建 waiter 时校验。
test("新分片传输计入其他文档等待向量占用", async () => {
  holdTimers();
  const sender = new YjsFragmentSender(() => {});
  const ws = createWs(65537);
  sender.send(ws, "chat:rcs-one", "gen-one", "update", new Uint8Array(9 * 1024 * 1024));
  sender.afterPending(
    ws,
    "chat:rcs-one",
    () => deliveredLegacyFrame(0),
    () => rejectedLegacyFrame(0, "backpressure"),
    () => rejectedLegacyFrame(0, "encode_failed"),
    MAX_YJS_SYNC_PAYLOAD_BYTES,
  );
  try {
    const delivery = sender.send(ws, "session:rcs-one", "gen-one", "update", new Uint8Array(48 * 1024 * 1024));
    expect(sender.hasPending(ws, "session:rcs-one")).toBe(false);
    expect(await delivery).toBe("backpressure");
  } finally {
    sender.cancelConnection(ws);
  }
});
