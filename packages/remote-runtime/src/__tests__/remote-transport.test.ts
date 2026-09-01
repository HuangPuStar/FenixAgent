import { expect, test } from "bun:test";
import { hasRuntimeFence, MACHINE_PROTOCOL_VERSION } from "../machine-protocol";
import { createRemoteRuntime } from "../remote-runtime";
import { createWsRemoteTransport, type TransportMessage, type WsConnectionLike } from "../remote-transport";

class FakeWsConnection implements WsConnectionLike {
  readyState = 1;
  onmessage: ((event: { data: string | Buffer }) => void) | null = null;
  readonly sent: string[] = [];
  readonly receivedByOriginalHandler: string[] = [];

  constructor(withOriginalHandler = false) {
    if (withOriginalHandler) {
      this.onmessage = (event) => {
        this.receivedByOriginalHandler.push(typeof event.data === "string" ? event.data : event.data.toString());
      };
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receive(data: string | Buffer): void {
    this.onmessage?.({ data });
  }
}

function createContext(withOriginalHandler = false): {
  transport: ReturnType<typeof createWsRemoteTransport>;
  ws: FakeWsConnection;
} {
  const ws = new FakeWsConnection(withOriginalHandler);
  return { transport: createWsRemoteTransport(ws), ws };
}

function sentMessage(ws: FakeWsConnection, index = 0): TransportMessage {
  const data = ws.sent[index];
  if (!data) throw new Error("未找到已发送的传输消息");
  return JSON.parse(data) as TransportMessage;
}

// Machine 协议 v2 以 instanceUid + generation + serverEpoch 构成完整 fencing token。
test("远程 lifecycle 请求端到端携带 fencing 字段", async () => {
  expect(MACHINE_PROTOCOL_VERSION).toBe(2);
  const { transport, ws } = createContext();
  const runtime = createRemoteRuntime({ transport, serverEpoch: "epoch-current" });
  const pending = runtime.startInstance({
    instanceId: "inst-current",
    instanceUid: "inst-current",
    runtimeGeneration: 7,
    serverEpoch: "epoch-current",
  });
  const request = sentMessage(ws);

  expect(request).toMatchObject({
    type: "start",
    instance_id: "inst-current",
    instance_uid: "inst-current",
    runtime_generation: 7,
    server_epoch: "epoch-current",
  });
  transport.injectMessage({ ...request, type: "start_result", status: "ok" });
  await pending;
});

// relay 数据帧同样必须携带 runtime fence，否则 Machine 协议 v2 会静默拒绝 action。
test("远程 relay action 携带 fencing 字段", async () => {
  const { transport, ws } = createContext();
  const runtime = createRemoteRuntime({ transport, serverEpoch: "epoch-current" });
  const relay = await runtime.connectRelay({
    instanceId: "inst-current",
    instanceUid: "inst-current",
    runtimeGeneration: 7,
    serverEpoch: "epoch-current",
    sessionId: "rcs-current",
  });

  relay.send({ type: "connect" });

  expect(sentMessage(ws)).toMatchObject({
    type: "relay",
    instance_id: "inst-current",
    instance_uid: "inst-current",
    runtime_generation: 7,
    server_epoch: "epoch-current",
    session_id: "rcs-current",
    payload: { type: "connect" },
  });
});

// 旧 epoch 或 generation 的结果不能通过当前 fencing 校验。
test("旧 generation 或 epoch 的结果被拒绝", () => {
  const expected = { instanceUid: "inst-current", runtimeGeneration: 8, serverEpoch: "epoch-current" };
  expect(
    hasRuntimeFence({ instance_uid: "inst-current", runtime_generation: 7, server_epoch: "epoch-current" }, expected),
  ).toBeFalse();
  expect(
    hasRuntimeFence({ instance_uid: "inst-current", runtime_generation: 8, server_epoch: "epoch-old" }, expected),
  ).toBeFalse();
});

// 缺失 generation/epoch 的旧调用必须 fail-closed，不能静默降级到无 fencing 协议。
test("远程 lifecycle 缺失 fencing 字段时 fail-closed", async () => {
  const { transport } = createContext();
  const runtime = createRemoteRuntime({ transport, serverEpoch: "epoch-current" });
  await expect(runtime.startInstance({ instanceId: "inst-current" })).rejects.toThrow("fence is required");
});

// relay 建连缺失 fencing 字段时必须 fail-closed，不能创建会被 Machine 静默拒绝的 handle。
test("远程 relay 缺失 fencing 字段时 fail-closed", async () => {
  const { transport } = createContext();
  const runtime = createRemoteRuntime({ transport, serverEpoch: "epoch-current" });

  await expect(runtime.connectRelay({ instanceId: "inst-current", sessionId: "rcs-current" })).rejects.toThrow(
    "fence is required",
  );
});

// 明确 request_id 必须原样用于请求匹配，避免同一连接上的并发响应串线。
test.each([
  ["prepare", "prepare-1"],
  ["start", "start-2"],
  ["stop", "stop-3"],
])("传输协议保留显式 request_id：%s", async (type, requestId) => {
  const { transport, ws } = createContext();
  const result = transport.sendAndWait({ type, request_id: requestId });

  expect(sentMessage(ws)).toMatchObject({ type, request_id: requestId });
  transport.injectMessage({ type: `${type}_result`, request_id: requestId });
  await expect(result).resolves.toMatchObject({ request_id: requestId });
});

// 未提供 request_id 时传输层必须生成可用于响应路由的协议字段。
test.each(["prepare", "start", "stop"])("传输协议为 %s 生成 request_id", async (type) => {
  const { transport, ws } = createContext();
  const result = transport.sendAndWait({ type });
  const request = sentMessage(ws);

  expect(request.request_id).toMatch(/^req_\d+_1$/);
  transport.injectMessage({ type: `${type}_result`, request_id: request.request_id });
  await expect(result).resolves.toMatchObject({ request_id: request.request_id });
});

// 请求字段不得在 JSON 序列化时丢失，远端依赖这些字段定位实例和会话。
test.each([
  [{ type: "prepare", instance_id: "instance-a" }],
  [{ type: "relay", instance_id: "instance-b", session_id: "session-b" }],
  [{ type: "prepare", engine_type: "opencode" }],
  [{ type: "relay", payload: { jsonrpc: "2.0", method: "session/prompt" } }],
])("传输协议序列化业务字段 %#", async (message) => {
  const { transport, ws } = createContext();
  const result = transport.sendAndWait(message);
  const request = sentMessage(ws);

  expect(request).toMatchObject(message);
  transport.injectMessage({ type: "ok", request_id: request.request_id });
  await expect(result).resolves.toMatchObject({ request_id: request.request_id });
});

// 并发请求只能由各自的 request_id 完成，未知响应不可误唤醒等待中的请求。
test.each([
  ["first", "second"],
  ["prepare-a", "prepare-b"],
  ["session-a", "session-b"],
  ["request-1", "request-2"],
])("并发请求按 request_id 隔离：%s 与 %s", async (firstId, secondId) => {
  const { transport } = createContext();
  const first = transport.sendAndWait({ type: "prepare", request_id: firstId });
  const second = transport.sendAndWait({ type: "start", request_id: secondId });

  transport.injectMessage({ type: "ignored", request_id: "unknown" });
  transport.injectMessage({ type: "second_result", request_id: secondId });
  await expect(second).resolves.toMatchObject({ request_id: secondId });
  transport.injectMessage({ type: "first_result", request_id: firstId });
  await expect(first).resolves.toMatchObject({ request_id: firstId });
});

// 带有实例和会话标识的非响应消息应分发给所有当前订阅者。
test.each([
  ["instance-1", "session-1"],
  ["instance-2", "session-2"],
  ["instance-3", "session-3"],
])("会话消息向订阅者分发：%s/%s", (instanceId, sessionId) => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));
  const message = { type: "relay", instance_id: instanceId, session_id: sessionId, payload: { sequence: 1 } };

  transport.injectMessage(message);
  expect(received).toEqual([message]);
});

// 取消订阅是 relay 清理的关键：后续会话消息不得保留已经释放的监听器。
test.each(["first", "second", "third"])("取消订阅后不再接收会话消息：%s", (label) => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  const unsubscribe = transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));

  unsubscribe();
  transport.injectMessage({ type: "relay", instance_id: `instance-${label}`, session_id: "session", payload: label });
  expect(received).toEqual([]);
});

// WS 单帧可以承载多行 JSON 消息，必须逐行解析并保持消息顺序。
test.each([
  ["one", "two"],
  ["alpha", "beta"],
  ["before", "after"],
])("WS 多行帧按顺序分发：%s 到 %s", (first, second) => {
  const { transport, ws } = createContext();
  const received: string[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message.type));

  ws.receive(
    `${JSON.stringify({ type: first, instance_id: "instance", session_id: "session" })}\n${JSON.stringify({ type: second, instance_id: "instance", session_id: "session" })}\n`,
  );
  expect(received).toEqual([first, second]);
});

// 损坏或不完整的帧属于不可信输入，必须被忽略而不影响之后的合法协议消息。
test.each(["{", "not-json", '{"type":'])("格式错误 WS 帧被安全忽略：%s", (invalidFrame) => {
  const { transport, ws } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));

  ws.receive(`${invalidFrame}\n${JSON.stringify({ type: "relay", instance_id: "instance", session_id: "session" })}`);
  expect(received).toEqual([{ type: "relay", instance_id: "instance", session_id: "session" }]);
});

// 超时请求必须拒绝并清理 pending 状态，迟到响应不能重新完成已失败的请求。
test.each(["prepare", "start", "relay"])("超时请求清理 pending 状态：%s", async (type) => {
  const { transport, ws } = createContext();
  const request = transport.sendAndWait({ type }, { timeout: 1 });
  const requestId = sentMessage(ws).request_id;

  await expect(request).rejects.toThrow(`type=${type}`);
  transport.injectMessage({ type: "late_result", request_id: requestId });
});

// send 是单向协议路径，不应添加 request_id 或建立等待中的请求状态。
test.each([
  [{ type: "relay" }],
  [{ type: "relay_close", instance_id: "instance" }],
  [{ type: "ping", payload: { at: 1 } }],
])("单向发送保持原始消息 %#", (message) => {
  const { transport, ws } = createContext();

  transport.send(message);
  expect(sentMessage(ws)).toEqual(message);
});

// 直连模式需要保留已有 onmessage 链，transport 不能吞掉宿主的原始处理器。
test.each(["first-frame", "second-frame", "third-frame"])("保留原始 WS 消息处理器：%s", (frame) => {
  const { ws } = createContext(true);

  ws.receive(frame);
  expect(ws.receivedByOriginalHandler).toEqual([frame]);
});

// Bun WS 可能交付 Buffer，二进制文本帧必须与字符串帧使用相同协议解析路径。
test.each(["buffer-one", "buffer-two"])("Buffer WS 帧可分发会话消息：%s", (type) => {
  const { transport, ws } = createContext();
  const received: string[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message.type));

  ws.receive(Buffer.from(JSON.stringify({ type, instance_id: "instance", session_id: "session" })));
  expect(received).toEqual([type]);
});

// 缺少任一会话隔离标识的通知不应泄露到会话监听器。
test.each([
  [{ type: "relay", instance_id: "instance" }],
  [{ type: "relay", session_id: "session" }],
  [{ type: "relay" }],
])("不完整会话标识不会触发分发 %#", (message) => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, incoming) => received.push(incoming));

  transport.injectMessage(message);
  expect(received).toEqual([]);
});
