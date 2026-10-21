import { expect, spyOn, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { createWsRemoteTransport, RemoteRelayHandle, type TransportMessage } from "@fenix/remote-runtime";
import { createInMemoryAgentRelay } from "./fixtures/in-memory-agent-relay";

// 真实 RemoteRelayHandle 会逐监听器复制包装帧，非所有者先订阅也不能消耗另一租约的 RPC 结果。
test("real RemoteRelayHandle routes cloned wrapped responses once before lease fanout and survives reconnect", async () => {
  const sent: TransportMessage[] = [];
  const transport = createWsRemoteTransport({
    readyState: 1,
    send(data) {
      sent.push(JSON.parse(data) as TransportMessage);
    },
  });
  const physical = new RemoteRelayHandle(transport, "relay-boundary", "rcs-wire", {
    instance_uid: "relay-boundary",
    runtime_generation: 1,
    server_epoch: "test",
  });
  const listening = spyOn(physical, "onMessage");
  const relay = await createInMemoryAgentRelay(undefined, physical);
  const reply = (id: unknown) =>
    transport.injectMessage({
      type: "relay",
      instance_id: "relay-boundary",
      session_id: "rcs-wire",
      payload: { type: "jsonrpc", payload: { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } } },
    });
  const wireId = () => (sent.at(-1)!.payload as { id: number }).id;
  const request = {
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: { sessionId: "ses-remote", content: [] },
  } as unknown as EngineRelayMessage;
  try {
    const [observer, owner] = await Promise.all([relay.connect(), relay.connect()]);
    const unrelated: EngineRelayMessage[] = [];
    const primary: EngineRelayMessage[] = [];
    const secondary: EngineRelayMessage[] = [];
    observer.onMessage!((message) => {
      unrelated.push(message);
    });
    owner.onMessage!((message) => {
      primary.push(message);
    });
    owner.onMessage!((message) => {
      secondary.push(message);
    });
    expect(listening).toHaveBeenCalledTimes(1);
    owner.send(request);
    reply(wireId());
    expect(unrelated).toEqual([]);
    expect(primary).toEqual([
      { type: "jsonrpc", payload: { jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } } },
    ]);
    expect(secondary).toEqual(primary);
    await owner.close();
    expect(observer.state).toBe("open");
    observer.send(request);
    const oldWireId = wireId();
    await observer.close();
    expect(physical.state).toBe("open");
    const replacement = await relay.connect();
    const replacementEvents: EngineRelayMessage[] = [];
    replacement.onMessage!((message) => {
      replacementEvents.push(message);
    });
    expect(listening).toHaveBeenCalledTimes(2);
    replacement.send(request);
    const currentWireId = wireId();
    expect(currentWireId).not.toBe(oldWireId);
    reply(oldWireId);
    expect(replacementEvents).toEqual([]);
    reply(currentWireId);
    expect(replacementEvents).toEqual(primary);
    expect(relay.connections()).toBe(1);
    await replacement.close();
  } finally {
    await relay.core.stopInstance("relay-boundary");
    transport.close();
    listening.mockRestore();
  }
});
