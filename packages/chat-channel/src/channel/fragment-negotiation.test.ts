import { expect, test } from "bun:test";
import * as Y from "yjs";
import { decodeYjsSyncFrame, encodeYjsStateVectorFrame, MAX_YJS_SYNC_PAYLOAD_BYTES } from "../protocol/update-frame";
import { YjsFragmentReceiver } from "../transport/update-fragments";
import { type LegacyFrameDelivery, YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createGateway, createRelayEvents, createWs } from "./connection-test-helpers";

// 网关登记连接早于能力协商，旧预算产生的阻塞不能在分片握手成功后继续拦截流式增量。
test("协商前超限的连接在分片同步后继续接收实时更新", async () => {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const source = new Y.Doc();
  const restored = new Y.Doc();
  const historySize = MAX_YJS_SYNC_PAYLOAD_BYTES + 1024;
  source.getText("history").insert(0, "x".repeat(historySize));
  const name = "chat:rcs-1";
  const ws = createWs();
  const receiver = new YjsFragmentReceiver(() => {});
  ws.send = (data) => {
    if (typeof data === "string") return;
    const decoded = decodeYjsSyncFrame(data);
    const frame = decoded?.type === "fragment" ? receiver.accept(decoded) : decoded;
    if (frame?.type === "update") Y.applyUpdate(restored, frame.update);
  };
  registry.addClient("ws-negotiation", createClient({ ws, relayReady: false }));
  broadcaster.registerYjsDocListener(source, name, "gen-one");
  const gateway = createGateway(
    registry,
    broadcaster,
    createRelayEvents(registry, broadcaster, []),
    {},
    {
      getChat: () => ({ ydoc: source, generation: "gen-one" }),
    },
  );
  let initial: LegacyFrameDelivery | undefined;
  const sendDiff = broadcaster.sendDiff.bind(broadcaster);
  broadcaster.sendDiff = (...args) => {
    const result = sendDiff(...args);
    initial = result;
    return result;
  };
  try {
    broadcaster.broadcastSnapshot(source, name, "gen-one");
    await gateway.handleMessage(ws, "ws-negotiation", JSON.stringify({ type: "yjs:fragment-support", version: 1 }));
    await gateway.handleMessage(ws, "ws-negotiation", encodeYjsStateVectorFrame(name, "gen-one", new Uint8Array()));
    expect((await initial?.completion)?.ok).toBe(true);
    expect(restored.getText("history").length).toBe(historySize);
    source.getMap("data").set("live", "must remain visible");
    await Bun.sleep(1_100);
    expect(restored.getMap("data").get("live")).toBe("must remain visible");
    expect(ws.closed).toEqual([]);
  } finally {
    gateway.handleClose("ws-negotiation");
    broadcaster.unregisterYjsDocListener(name);
    receiver.reset();
    source.destroy();
    restored.destroy();
  }
});
