import { expect, test } from "bun:test";
import * as Y from "yjs";
import {
  decodeYjsSyncFrame,
  MAX_YJS_FRAGMENT_PAYLOAD_BYTES,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
} from "../protocol/update-frame";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import type { WsConnection } from "./connection-types";
import { YjsFragmentSender } from "./fragment-delivery";

// 恢复原有普通帧预算，2 MiB 分片大小不应把原本可发送的旧客户端载荷挡住。
test("超过 2 MiB 且未达 8 MiB 的载荷仍使用普通帧", () => {
  const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
  const doc = new Y.Doc();
  doc.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES - 1024));
  const sent: Uint8Array[] = [];
  const socket: WsConnection = {
    readyState: 1,
    send: (frame) => {
      if (frame instanceof Uint8Array) sent.push(frame);
    },
    close: () => {},
  };
  try {
    const delivery = broadcaster.sendSnapshot(socket, doc, "chat:rcs-one", "gen-one");
    expect(delivery.ok).toBe(true);
    expect(delivery.completion).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBeGreaterThan(MAX_YJS_FRAGMENT_PAYLOAD_BYTES);
    expect(decodeYjsSyncFrame(sent[0]!)?.type).toBe("update");
  } finally {
    doc.destroy();
  }
});

// 慢连接等待排水期间不能阻塞另一个连接；主动断开立即停止发送。
test("分片背压隔离连接并支持立即取消", async () => {
  const sender = new YjsFragmentSender(() => {});
  const frames: unknown[] = [];
  const slow: WsConnection & { bufferedAmount: number } = {
    readyState: 1,
    bufferedAmount: 65537,
    send: () => {
      throw new Error("must wait");
    },
    close: () => {},
  };
  const healthy: WsConnection = { readyState: 1, send: (frame) => frames.push(frame), close: () => {} };
  const payload = new Uint8Array(2 * MAX_YJS_SYNC_PAYLOAD_BYTES);
  const pending = sender.send(slow, "chat:rcs-one", "gen-one", "update", payload);
  try {
    expect(await sender.send(healthy, "chat:rcs-two", "gen-two", "update", payload)).toBe("delivered");
    expect(frames.length).toBeGreaterThan(1);
    expect(sender.hasPending(slow, "chat:rcs-one")).toBe(true);
    sender.cancelConnection(slow);
    expect(await pending).toBe("backpressure");
    expect(sender.hasPending(slow, "chat:rcs-one")).toBe(false);
  } finally {
    sender.cancelConnection(slow);
    sender.cancelConnection(healthy);
  }
});

// 不声明能力的旧标签页不能接收未知分片并被误报为同步完成。
test("旧客户端明确失败，新客户端等待完整分片投递", async () => {
  const broadcaster = new YjsBroadcaster(new ConnectionRegistry());
  const doc = new Y.Doc();
  doc.getText("history").insert(0, "x".repeat(2 * MAX_YJS_SYNC_PAYLOAD_BYTES));
  const sent: unknown[] = [];
  const socket: WsConnection = { readyState: 1, send: (frame) => sent.push(frame), close: () => {} };
  try {
    const unsupported = broadcaster.sendSnapshot(socket, doc, "chat:rcs-one", "gen-one");
    expect(unsupported.reason).toBe("too_large");
    expect(unsupported.completion).toBeUndefined();
    expect(sent).toHaveLength(0);
    broadcaster.enableFragmentSupport(socket);
    const supported = broadcaster.sendSnapshot(socket, doc, "chat:rcs-one", "gen-one");
    expect(supported.ok).toBe(false);
    expect(supported.reason).toBeNull();
    const following = broadcaster.sendSnapshot(socket, doc, "chat:rcs-one", "gen-one");
    expect(following.reason).toBeNull();
    expect((await supported.completion)?.ok).toBe(true);
    expect((await following.completion)?.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
  } finally {
    broadcaster.cancelConnection(socket);
    doc.destroy();
  }
});
