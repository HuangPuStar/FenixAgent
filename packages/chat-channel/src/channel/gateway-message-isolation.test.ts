// packages/chat-channel/src/channel/gateway-message-isolation.test.ts
// 入站消息隔离与 legacy 超限帧回归：单个连接的处理失败不得变成未处理拒绝带走进程；
// 超过 8MiB 的 legacy 全量 diff 只丢帧并留诊断，不能关闭与新同步协议共用的 socket。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { encodeYjsStateVectorFrame } from "../protocol/update-frame";
import { decodeSyncFrame, encodeSyncFrame, SYNC_PROTOCOL_VERSION } from "../sync/protocol/frames";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createGateway, createRelayEvents, createWs } from "./connection-test-helpers";

const RCS_SESSION_ID = "rcs-1";
const GENERATION = "gen-big";

function stateVectorFrame(): Uint8Array {
  return encodeYjsStateVectorFrame(`chat:${RCS_SESSION_ID}`, GENERATION, new Uint8Array());
}

describe("Gateway 单连接消息隔离", () => {
  // 9MiB legacy Chat Doc 的全量 diff 超过 8MiB 上限：只丢该帧并记录大小，连接保持打开（新同步协议仍可用）。
  test("超限 legacy diff 丢帧但进程与连接存活", async () => {
    const registry = new ConnectionRegistry();
    const logs: string[] = [];
    const broadcaster = new YjsBroadcaster(registry, { reportLog: (message) => logs.push(message) });
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const big = new Y.Doc();
    big.getText("big").insert(0, "x".repeat(9 * 1024 * 1024));
    const gateway = createGateway(
      registry,
      broadcaster,
      relayEvents,
      {
        chatSyncProtocol: { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
      },
      { getChat: () => ({ ydoc: big, generation: GENERATION }), getSession: () => undefined },
    );
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws, rcsSessionId: RCS_SESSION_ID }));

    await gateway.handleMessage(ws, "ws-1", stateVectorFrame());

    expect(ws.closed).toEqual([]);
    expect(ws.messages.filter((message) => message instanceof Uint8Array)).toHaveLength(0);
    expect(logs.some((message) => message.includes("dropped oversized legacy update"))).toBe(true);
    expect(registry.getClient("ws-1")).toBeDefined();
    // 首次同步 500ms 超时后走的 sendSnapshot 同样不能抛出，否则会把 open 流程变成 setup failed。
    expect(() => broadcaster.sendSnapshot(ws, big, `chat:${RCS_SESSION_ID}`, GENERATION)).not.toThrow();
    expect(ws.messages.filter((message) => message instanceof Uint8Array)).toHaveLength(0);

    // 同一条 socket 上的新同步协议必须仍然可用：HELLO 能得到 MANIFEST，不因 legacy 超限帧被关闭。
    await gateway.handleMessage(
      ws,
      "ws-1",
      encodeSyncFrame({
        type: "HELLO",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        scope: { organizationId: "org-1", rcsSessionId: RCS_SESSION_ID },
        loadedDocs: [],
        stateful: false,
      }),
    );
    const syncFrames = ws.messages
      .filter((message): message is Uint8Array => message instanceof Uint8Array)
      .map((message) => decodeSyncFrame(message));
    expect(syncFrames.some((frame) => frame.type === "MANIFEST")).toBe(true);
    expect(ws.closed).toEqual([]);
    gateway.handleClose("ws-1");
  });

  // 任意 legacy 出站异常只关闭当前连接：handleMessage 不抛出，登记被清理，其他连接与进程不受影响。
  test("单连接处理异常被捕获并只关闭该连接", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const errors: string[] = [];
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const doc = new Y.Doc();
    const gateway = createGateway(
      registry,
      broadcaster,
      relayEvents,
      { reportError: (message, error) => errors.push(`${message}: ${String(error)}`) },
      { getChat: () => ({ ydoc: doc, generation: GENERATION }), getSession: () => undefined },
    );
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws, rcsSessionId: RCS_SESSION_ID }));
    broadcaster.sendDiff = () => {
      throw new Error("simulated legacy send failure");
    };

    await expect(gateway.handleMessage(ws, "ws-1", stateVectorFrame())).resolves.toBeUndefined();
    expect(ws.closed).toEqual([[1011, "message handling failed"]]);
    expect(registry.getClient("ws-1")).toBeUndefined();
    expect(errors.some((message) => message.includes("message handling failed"))).toBe(true);
  });
});
