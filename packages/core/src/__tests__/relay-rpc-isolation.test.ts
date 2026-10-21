import { expect, spyOn, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { createLaunchSpec, createTestContext } from "./fixtures/orchestrator-context";

async function setup() {
  const context = createTestContext();
  const physical = context.plugin.runtimeState.relay;
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  physical.onMessage = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  await context.orchestrator.launch({
    instanceId: "instance",
    engineType: "fake-engine",
    nodeId: "local-default",
    launchSpec: createLaunchSpec(),
  });
  return {
    ...context,
    physical,
    listeners,
    emit(message: unknown) {
      for (const listener of listeners) listener(message as EngineRelayMessage);
    },
    request(id: number | string, sessionId: string, wrapped = false) {
      const rpc = { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, content: [] } };
      return (wrapped ? { type: "jsonrpc", payload: rpc } : rpc) as unknown as EngineRelayMessage;
    },
  };
}
function wireId(message: EngineRelayMessage): unknown {
  return (message as unknown as { id?: unknown }).id ?? (message.payload as { id?: unknown } | undefined)?.id;
}

// 所有消费者归零后复用原物理连接，旧结果无 sessionId 也不能命中新 lease 复用的局部 RPC 编号。
test("physical RPC namespace survives zero consumers and drops delayed old results without a session id", async () => {
  for (const wrapped of [false, true]) {
    const context = await setup();
    const first = await context.orchestrator.connectRelay({ instanceId: "instance" });
    first.onMessage!(() => {});
    first.send(context.request(1, "ses-old", wrapped));
    const oldWireId = wireId(context.physical.sentMessages[0]!);
    await first.close();
    expect(context.listeners.size).toBe(0);
    const replacement = await context.orchestrator.connectRelay({ instanceId: "instance" });
    const received: EngineRelayMessage[] = [];
    replacement.onMessage!((message) => {
      received.push(message);
    });
    replacement.send(context.request(1, "ses-new", wrapped));
    const newWireId = wireId(context.physical.sentMessages[1]!);
    expect(oldWireId).not.toBe(newWireId);
    const oldResult = { jsonrpc: "2.0", id: oldWireId, result: { stopReason: "end_turn" } };
    context.emit(wrapped ? { type: "jsonrpc", payload: oldResult } : oldResult);
    expect(received).toEqual([]);
    context.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "ses-old", update: {} } });
    expect(received).toEqual([]);
    const newResult = { jsonrpc: "2.0", id: newWireId, result: { stopReason: "end_turn" } };
    context.emit(wrapped ? { type: "jsonrpc", payload: newResult } : newResult);
    expect(received).toHaveLength(1);
    expect(wireId(received[0]!)).toBe(1);
    expect(context.plugin.runtimeState.connectRelayCalls).toBe(1);
    expect(context.physical.state).toBe("open");
    await context.orchestrator.stop("instance");
  }
});

// RPC 响应只交给请求所有者，Agent 反向权限请求的原始 ID 及消费侧响应不能被改写。
test("simultaneous leases isolate results and preserve reverse permission request response ids", async () => {
  const context = await setup();
  const [a, b] = await Promise.all([
    context.orchestrator.connectRelay({ instanceId: "instance" }),
    context.orchestrator.connectRelay({ instanceId: "instance" }),
  ]);
  const eventsA: EngineRelayMessage[] = [];
  const eventsB: EngineRelayMessage[] = [];
  a.onMessage!((message) => {
    eventsA.push(message);
  });
  a.onMessage!((message) => {
    expect(message).toBe(eventsA.at(-1)!);
  });
  b.onMessage!((message) => {
    eventsB.push(message);
  });
  a.send(context.request("same", "ses-a"));
  b.send(context.request("same", "ses-b", true));
  context.emit({
    jsonrpc: "2.0",
    id: wireId(context.physical.sentMessages[0]!),
    error: { code: -32000, message: "rejected" },
  });
  expect(eventsA).toHaveLength(1);
  expect(wireId(eventsA[0]!)).toBe("same");
  expect(eventsB).toEqual([]);
  const permission = {
    jsonrpc: "2.0",
    id: "perm-1",
    method: "session/request_permission",
    params: { sessionId: "ses-b", options: [] },
  };
  context.emit(permission);
  expect(eventsA).toHaveLength(1);
  expect(eventsB).toEqual([permission as unknown as EngineRelayMessage]);
  const answer = { jsonrpc: "2.0", id: "perm-1", result: { outcome: { outcome: "cancelled" } } };
  b.send(answer as unknown as EngineRelayMessage);
  expect(context.physical.sentMessages.at(-1)).toEqual(answer as unknown as EngineRelayMessage);
  await a.close();
  context.emit({
    type: "jsonrpc",
    payload: { jsonrpc: "2.0", id: wireId(context.physical.sentMessages[1]!), result: { stopReason: "end_turn" } },
  });
  expect(eventsB).toHaveLength(2);
  expect(wireId(eventsB[1]!)).toBe("same");
  expect(b.state).toBe("open");
  await context.orchestrator.stop("instance");
});

// 带 sessionId 的通知也登记消费目标，反向权限请求的响应仍保留 Agent 的原始编号。
test("session notification registers its target without allocating a consumer RPC id", async () => {
  const context = await setup();
  const lease = await context.orchestrator.connectRelay({ instanceId: "instance" });
  const received: EngineRelayMessage[] = [];
  lease.onMessage!((message) => {
    received.push(message);
  });
  const notification = { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "ses-notification" } };
  lease.send({ type: "jsonrpc", payload: notification });
  expect(context.physical.sentMessages[0]).toEqual({ type: "jsonrpc", payload: notification });
  const permission = {
    type: "jsonrpc",
    payload: {
      jsonrpc: "2.0",
      id: "perm-original",
      method: "session/request_permission",
      params: { sessionId: "ses-notification" },
    },
  };
  context.emit(permission);
  expect(received).toEqual([permission]);
  const answer = {
    type: "jsonrpc",
    payload: { jsonrpc: "2.0", id: "perm-original", result: { outcome: { outcome: "cancelled" } } },
  };
  lease.send(answer);
  expect(context.physical.sentMessages.at(-1)).toEqual(answer);
  await context.orchestrator.stop("instance");
});

// 单个消费回调失败不能阻断同租约其他监听器或邻居租约的状态及响应，诊断不得携带错误原文。
test("failing consumer callback is diagnosed without blocking its owner or neighbouring status delivery", async () => {
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  const context = await setup();
  try {
    const [a, b] = await Promise.all([
      context.orchestrator.connectRelay({ instanceId: "instance" }),
      context.orchestrator.connectRelay({ instanceId: "instance" }),
    ]);
    const eventsA: EngineRelayMessage[] = [];
    const eventsB: EngineRelayMessage[] = [];
    a.onMessage!(() => {
      throw new Error("private fixture details");
    });
    a.onMessage!((message) => {
      eventsA.push(message);
    });
    b.onMessage!((message) => {
      eventsB.push(message);
    });
    a.send(context.request(1, "ses-a"));
    b.send(context.request(1, "ses-b"));
    const status: EngineRelayMessage = { type: "status", payload: { connected: true } };
    context.emit(status);
    expect(eventsA).toEqual([status]);
    expect(eventsB).toEqual([status]);
    context.emit({ jsonrpc: "2.0", id: wireId(context.physical.sentMessages[0]!), result: { stopReason: "end_turn" } });
    context.emit({ jsonrpc: "2.0", id: wireId(context.physical.sentMessages[1]!), result: { stopReason: "end_turn" } });
    expect(eventsA).toHaveLength(2);
    expect(eventsB).toHaveLength(2);
    expect(wireId(eventsA[1]!)).toBe(1);
    expect(wireId(eventsB[1]!)).toBe(1);
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private fixture details");
  } finally {
    await context.orchestrator.stop("instance");
    diagnostic.mockRestore();
  }
});
