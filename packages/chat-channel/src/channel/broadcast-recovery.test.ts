import { afterEach, describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { MAX_YJS_SYNC_PAYLOAD_BYTES } from "../protocol/update-frame";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createWs, decodeUpdateFrames, type MockWs } from "./connection-test-helpers";
import type { ClientConnection } from "./connection-types";

const WS_SEND_THRESHOLD = 64 * 1024;
const LAGGING_CLOSE_TIMEOUT_MS = 30_000;
const originalNow = Date.now;
let now = 0;
/** 容量失败不应消耗慢连接超时时间，使用固定时钟验证。 */
function installFakeClock(): void {
  now = 0;
  Date.now = () => now;
}
afterEach(() => {
  Date.now = originalNow;
});
/** 注册同会话的传统动作连接。 */
function addClient(registry: ConnectionRegistry, id: string, ws: MockWs, rcsSessionId: string): void {
  registry.addClient(id, { ws, rcsSessionId, pendingMessages: [] } as unknown as ClientConnection);
}
/** 等待文档批量广播交付。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe("超限广播恢复", () => {
  // 容量上限是确定性失败，不能重复追赶同一超大快照，最终误关承载动作的共享 socket。
  test.each(["broadcast", "resync"] as const)("%s 的快照持续超限时保留共享连接", async (path) => {
    installFakeClock();
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "oversized", ws, "rcs-oversized");
    const doc = new Y.Doc();
    doc.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    const name = "chat:rcs-oversized";
    broadcaster.registerYjsDocListener(doc, name, "gen-large");
    try {
      if (path === "broadcast") broadcaster.broadcastSnapshot(doc, name, "gen-large");
      else {
        ws.bufferedAmount = WS_SEND_THRESHOLD + 1;
        doc.getMap("data").set("late", true);
        await flushMicrotasks();
        ws.bufferedAmount = 0;
      }
      broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
      now += LAGGING_CLOSE_TIMEOUT_MS + 1;
      broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
      expect(ws.closed).toEqual([]);
      expect(ws.messages.filter((frame) => typeof frame === "string")).toHaveLength(2);
    } finally {
      broadcaster.cancelConnection(ws);
      broadcaster.unregisterYjsDocListener(name);
      doc.destroy();
    }
  });

  // 聚合更新超限但当前投影已收缩时，仍应从可发送的快照恢复，而非永久丢弃。
  test("超限广播对应的当前投影较小时仍可追赶", async () => {
    installFakeClock();
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "compacted", ws, "rcs-compacted");
    const current = new Y.Doc();
    current.getMap("data").set("value", "small current projection");
    const oversized = new Y.Doc();
    oversized.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    broadcaster.registerYjsDocListener(current, "chat:rcs-compacted", "gen-current");
    try {
      broadcaster.broadcastSnapshot(oversized, "chat:rcs-compacted", "gen-current");
      await Bun.sleep(1_050);
      broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
      expect(decodeUpdateFrames(ws)).toHaveLength(1);
      expect(ws.closed).toEqual([]);
    } finally {
      broadcaster.cancelConnection(ws);
      broadcaster.unregisterYjsDocListener("chat:rcs-compacted");
      current.destroy();
      oversized.destroy();
    }
  });

  // 超限后再发生 GC 收缩也不能遗忘缺失基线，否则后续小增量会因前序 clock 缺失而悬空。
  test("快照超限后缩小文档会补齐基线并恢复后续更新", async () => {
    installFakeClock();
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const ws = createWs();
    addClient(registry, "shrinking", ws, "rcs-shrinking");
    const source = new Y.Doc();
    const restored = new Y.Doc();
    const history = source.getText("history");
    history.insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
    broadcaster.registerYjsDocListener(source, "chat:rcs-shrinking", "gen-one");
    try {
      broadcaster.broadcastSnapshot(source, "chat:rcs-shrinking", "gen-one");
      source.transact(() => {
        history.delete(0, history.length);
        source.getMap("data").set("title", "recovered");
      });
      await flushMicrotasks();
      await Bun.sleep(1_050);
      broadcaster.sendToYjsWs(ws, { type: "keep_alive" });
      for (const frame of decodeUpdateFrames(ws)) Y.applyUpdate(restored, frame.update);
      expect(restored.getMap("data").get("title")).toBe("recovered");
      expect(ws.closed).toEqual([]);
    } finally {
      broadcaster.cancelConnection(ws);
      broadcaster.unregisterYjsDocListener("chat:rcs-shrinking");
      source.destroy();
      restored.destroy();
    }
  });
});
