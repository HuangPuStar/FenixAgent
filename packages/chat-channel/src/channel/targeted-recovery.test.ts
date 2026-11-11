import { expect, test } from "bun:test";
import * as Y from "yjs";
import {
  decodeYjsSyncFrame,
  encodeYjsStateVectorFrame,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  MAX_YJS_TRANSFER_BYTES,
} from "../protocol/update-frame";
import { YjsFragmentReceiver } from "../transport/update-fragments";
import { type LegacyFrameDelivery, YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createGateway, createRelayEvents, createWs, textFrames } from "./connection-test-helpers";

// 定向差量和超时快照均需保存缺失基线；缩小后自动补齐数据并发送真正的完成证明。
test.each([
  { path: "state-vector", fragments: false },
  { path: "snapshot", fragments: false },
  { path: "state-vector", fragments: true },
  { path: "snapshot", fragments: true },
])("$path 超限后缩小可自动恢复（分片能力：$fragments）", async ({ path, fragments }) => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  const session = new Y.Doc();
  const restored = new Y.Doc();
  const limit = fragments ? MAX_YJS_TRANSFER_BYTES : MAX_YJS_SYNC_PAYLOAD_BYTES;
  source.getText("history").insert(0, "x".repeat(limit + 1024));
  const generation = "gen-targeted";
  source.getMap("root").set("projectionGeneration", generation);
  session.getMap("root").set("projectionGeneration", generation);
  const chatDoc = { ydoc: source, generation };
  const sessionDoc = { ydoc: session, generation };
  const ws = createWs();
  const receiver = new YjsFragmentReceiver(() => {});
  const completeTitles: unknown[] = [];
  const messages: Promise<void>[] = [];
  const gateway = createGateway(
    registry,
    broadcaster,
    createRelayEvents(registry, broadcaster, []),
    {},
    {
      openChat: async () => chatDoc,
      openSession: async () => sessionDoc,
      getChat: () => chatDoc,
      getSession: () => sessionDoc,
    },
  );
  ws.send = (data) => {
    ws.messages.push(data);
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.type === "yjs:sync-request")
        messages.push(
          (async () => {
            if (fragments)
              await gateway.handleMessage(
                ws,
                "ws-targeted",
                JSON.stringify({ type: "yjs:fragment-support", version: 1 }),
              );
            if (path === "state-vector")
              for (const doc of frame.docs)
                await gateway.handleMessage(
                  ws,
                  "ws-targeted",
                  encodeYjsStateVectorFrame(doc.docName, doc.generation, new Uint8Array()),
                );
          })(),
        );
      if (frame.type === "yjs:sync-complete") completeTitles.push(restored.getMap("data").get("title"));
      return;
    }
    const decoded = decodeYjsSyncFrame(data);
    const frame = decoded?.type === "fragment" ? receiver.accept(decoded) : decoded;
    if (frame?.type === "update" && frame.docName === "chat:rcs-1") Y.applyUpdate(restored, frame.update);
  };
  try {
    await gateway.handleOpen(ws, "ws-targeted", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });
    await Promise.all(messages);
    const incomplete = () =>
      textFrames(ws)
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type === "yjs:history-incomplete");
    expect(incomplete()).toHaveLength(1);
    expect(incomplete()[0].reason).toBe("too_large");
    expect(completeTitles).toEqual([]);
    expect(registry.getClient("ws-targeted")?.relayReady).toBe(true);
    const retained = fragments ? MAX_YJS_SYNC_PAYLOAD_BYTES + 1024 : 0;
    source.transact(() => {
      const history = source.getText("history");
      history.delete(retained, history.length - retained);
      source.getMap("data").set("title", "recovered");
    });
    const deadline = performance.now() + 2_500;
    while (completeTitles.length === 0 && performance.now() < deadline) await Bun.sleep(10);
    expect(restored.getMap("data").get("title")).toBe("recovered");
    expect(restored.getText("history").length).toBe(retained);
    expect(completeTitles).toEqual(["recovered"]);
    source.getMap("data").set("tail", "still live");
    await Promise.resolve();
    expect(restored.getMap("data").get("tail")).toBe("still live");
    expect(ws.closed).toEqual([]);
  } finally {
    gateway.handleClose("ws-targeted");
    broadcaster.unregisterYjsDocListener("chat:rcs-1");
    broadcaster.unregisterYjsDocListener("session:rcs-1");
    receiver.reset();
    for (const doc of [source, session, restored]) doc.destroy();
  }
});

// 等待旧分片后重算才超限时，也必须继续携带恢复回调，不能只处理立即失败的定向请求。
test("等待在途基线后才超限的差量仍可恢复并回调", async () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  const restored = new Y.Doc();
  const receiver = new YjsFragmentReceiver(() => {});
  const ws = createWs();
  const name = "chat:rcs-deferred";
  source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  ws.send = (data) => {
    if (typeof data === "string") return;
    const decoded = decodeYjsSyncFrame(data);
    const frame = decoded?.type === "fragment" ? receiver.accept(decoded) : decoded;
    if (frame?.type === "update") Y.applyUpdate(restored, frame.update);
  };
  registry.addClient("ws-deferred", createClient({ ws, rcsSessionId: "rcs-deferred" }));
  broadcaster.registerYjsDocListener(source, name, "gen-one");
  broadcaster.enableFragmentSupport(ws);
  const recovered: LegacyFrameDelivery[] = [];
  try {
    broadcaster.sendSnapshot(ws, source, name, "gen-one");
    const waiting = broadcaster.sendDiff(ws, source, name, "gen-one", new Uint8Array(), (result) =>
      recovered.push(result),
    );
    source.getText("history").insert(0, "x".repeat(MAX_YJS_TRANSFER_BYTES));
    expect((await waiting.completion)?.reason).toBe("too_large");
    expect(recovered).toEqual([]);
    source.transact(() => {
      const history = source.getText("history");
      history.delete(0, history.length);
      source.getMap("data").set("title", "deferred recovery");
    });
    const deadline = performance.now() + 2_500;
    while (recovered.length === 0 && performance.now() < deadline) await Bun.sleep(10);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.ok).toBe(true);
    expect(restored.getMap("data").get("title")).toBe("deferred recovery");
  } finally {
    broadcaster.cancelConnection(ws);
    broadcaster.unregisterYjsDocListener(name);
    receiver.reset();
    source.destroy();
    restored.destroy();
  }
});

// 超大快照失败后客户端可用已有历史接收小差量；成功恢复必须同时解除后续实时广播阻塞。
test("迟到的小差量恢复成功后继续接收实时更新", async () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  const session = new Y.Doc();
  const restored = new Y.Doc();
  const generation = "gen-late-diff";
  source.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  for (const doc of [source, session]) doc.getMap("root").set("projectionGeneration", generation);
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));
  source.getMap("data").set("title", "recovered by diff");
  const chatDoc = { ydoc: source, generation };
  const sessionDoc = { ydoc: session, generation };
  const ws = createWs();
  const gateway = createGateway(
    registry,
    broadcaster,
    createRelayEvents(registry, broadcaster, []),
    {},
    {
      openChat: async () => chatDoc,
      openSession: async () => sessionDoc,
      getChat: () => chatDoc,
      getSession: () => sessionDoc,
    },
  );
  ws.send = (data) => {
    ws.messages.push(data);
    if (typeof data === "string") return;
    const frame = decodeYjsSyncFrame(data);
    if (frame?.type === "update" && frame.docName === "chat:rcs-1") Y.applyUpdate(restored, frame.update);
  };
  const frames = (type: string) =>
    textFrames(ws)
      .map((frame) => JSON.parse(frame))
      .filter((frame) => frame.type === type);
  const retry = () =>
    gateway.handleMessage(
      ws,
      "ws-late",
      encodeYjsStateVectorFrame("chat:rcs-1", generation, Y.encodeStateVector(restored)),
    );
  try {
    await gateway.handleOpen(ws, "ws-late", "user-1", "agent-1", { instanceUid: "instance-1", rcsSessionId: "rcs-1" });
    expect(frames("yjs:history-incomplete")[0]?.reason).toBe("too_large");
    ws.bufferedAmount = 65537;
    await retry();
    expect(frames("yjs:sync-complete")).toEqual([]);
    expect(restored.getMap("data").get("title")).toBeUndefined();
    ws.bufferedAmount = 0;
    const sentBeforeRetry = ws.messages.length;
    source.getMap("data").set("beforeRetry", "still needs baseline");
    await Promise.resolve();
    expect(ws.messages).toHaveLength(sentBeforeRetry);
    await retry();
    expect(frames("yjs:sync-complete")).toHaveLength(1);
    expect(restored.getMap("data").get("title")).toBe("recovered by diff");
    expect(Y.encodeStateAsUpdate(source).length).toBeGreaterThan(MAX_YJS_SYNC_PAYLOAD_BYTES);
    source.getMap("data").set("tail", "live after recovery");
    await Promise.resolve();
    expect(restored.getMap("data").get("tail")).toBe("live after recovery");
    expect(ws.closed).toEqual([]);
  } finally {
    gateway.handleClose("ws-late");
    broadcaster.unregisterYjsDocListener("chat:rcs-1");
    broadcaster.unregisterYjsDocListener("session:rcs-1");
    for (const doc of [source, session, restored]) doc.destroy();
  }
});

// socket 发送过程可能触发换代，旧代的成功回调不能清除新代缺失基线的容量阻塞。
test("旧代定向发送成功不能解除新代容量阻塞", async () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const old = new Y.Doc();
  const next = new Y.Doc();
  old.getMap("data").set("title", "old");
  next.getText("history").insert(0, "x".repeat(MAX_YJS_SYNC_PAYLOAD_BYTES + 1024));
  const ws = createWs();
  const name = "chat:rcs-stale";
  let replaced = false;
  ws.send = (data) => {
    ws.messages.push(data);
    if (replaced || typeof data === "string") return;
    replaced = true;
    broadcaster.registerYjsDocListener(next, name, "gen-new");
    broadcaster.broadcastSnapshot(next, name, "gen-new");
  };
  registry.addClient("ws-stale", createClient({ ws, rcsSessionId: "rcs-stale" }));
  broadcaster.registerYjsDocListener(old, name, "gen-old");
  try {
    expect(broadcaster.sendSnapshot(ws, old, name, "gen-old").ok).toBe(true);
    next.getMap("data").set("tail", "requires new baseline");
    await Promise.resolve();
    const updates = ws.messages.flatMap((data) => {
      const frame = typeof data === "string" ? null : decodeYjsSyncFrame(data);
      return frame?.type === "update" ? [frame.generation] : [];
    });
    expect(updates).toEqual(["gen-old"]);
    expect(ws.closed).toEqual([]);
  } finally {
    broadcaster.cancelConnection(ws);
    broadcaster.unregisterYjsDocListener(name);
    old.destroy();
    next.destroy();
  }
});
