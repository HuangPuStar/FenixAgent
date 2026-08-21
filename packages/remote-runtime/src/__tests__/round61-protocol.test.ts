import { expect, test } from "bun:test";
import { createWsRemoteTransport, type TransportMessage, type WsConnectionLike } from "../remote-transport";

class MemoryWsConnection implements WsConnectionLike {
  readyState = 1;
  onmessage: ((event: { data: string | Buffer }) => void) | null = null;
  readonly sent: string[] = [];
  readonly originalFrames: string[] = [];

  constructor(withOriginalHandler = false) {
    if (withOriginalHandler) {
      this.onmessage = (event) => {
        this.originalFrames.push(typeof event.data === "string" ? event.data : event.data.toString());
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
  ws: MemoryWsConnection;
} {
  const ws = new MemoryWsConnection(withOriginalHandler);
  return { transport: createWsRemoteTransport(ws), ws };
}

function sentMessage(ws: MemoryWsConnection, index = 0): TransportMessage {
  const data = ws.sent[index];
  if (!data) throw new Error("未找到内存连接已发送的协议消息");
  return JSON.parse(data) as TransportMessage;
}

// 单向消息必须按原始协议字段写入内存连接，且不附加请求等待标识。
test("协议单向发送保留原始消息", () => {
  const { transport, ws } = createContext();
  const message = { type: "relay", instance_id: "instance-1", payload: { text: "hello" } };

  transport.send(message);

  expect(sentMessage(ws)).toEqual(message);
});

// 未指定 request_id 的请求必须生成可由响应路由使用的协议标识。
test("协议请求自动生成 request_id", async () => {
  const { transport, ws } = createContext();
  const pending = transport.sendAndWait({ type: "start" });
  const request = sentMessage(ws);

  expect(request.request_id).toMatch(/^req_\d+_1$/);
  transport.injectMessage({ type: "start_result", request_id: request.request_id });
  await expect(pending).resolves.toEqual({ type: "start_result", request_id: request.request_id });
});

// 调用方提供的 request_id 必须原样发送，避免跨调用的响应串线。
test("协议请求保留显式 request_id", async () => {
  const { transport, ws } = createContext();
  const pending = transport.sendAndWait({ type: "prepare", request_id: "prepare-request" });

  expect(sentMessage(ws)).toMatchObject({ type: "prepare", request_id: "prepare-request" });
  transport.injectMessage({ type: "prepare_result", request_id: "prepare-request", status: "ok" });
  await expect(pending).resolves.toMatchObject({ status: "ok" });
});

// 请求序号必须在同一内存传输中递增，以便每个等待项拥有独立键。
test("协议请求生成递增的 request_id", async () => {
  const { transport, ws } = createContext();
  const first = transport.sendAndWait({ type: "start" });
  const second = transport.sendAndWait({ type: "stop" });
  const firstRequest = sentMessage(ws, 0);
  const secondRequest = sentMessage(ws, 1);

  expect(firstRequest.request_id).toMatch(/^req_\d+_1$/);
  expect(secondRequest.request_id).toMatch(/^req_\d+_2$/);
  transport.injectMessage({ type: "start_result", request_id: firstRequest.request_id });
  transport.injectMessage({ type: "stop_result", request_id: secondRequest.request_id });
  await expect(first).resolves.toMatchObject({ request_id: firstRequest.request_id });
  await expect(second).resolves.toMatchObject({ request_id: secondRequest.request_id });
});

// 响应仅能完成 request_id 相同的等待项，乱序响应不得影响另一请求。
test("协议响应按 request_id 隔离", async () => {
  const { transport } = createContext();
  const first = transport.sendAndWait({ type: "prepare", request_id: "first" });
  const second = transport.sendAndWait({ type: "start", request_id: "second" });

  transport.injectMessage({ type: "start_result", request_id: "second" });
  await expect(second).resolves.toMatchObject({ request_id: "second" });
  transport.injectMessage({ type: "prepare_result", request_id: "first" });
  await expect(first).resolves.toMatchObject({ request_id: "first" });
});

// 未知 request_id 不得误完成任意等待项，合法响应仍应随后正常完成。
test("未知响应不会串线到等待请求", async () => {
  const { transport } = createContext();
  const pending = transport.sendAndWait({ type: "start", request_id: "known" });

  transport.injectMessage({ type: "start_result", request_id: "unknown" });
  transport.injectMessage({ type: "start_result", request_id: "known" });

  await expect(pending).resolves.toMatchObject({ request_id: "known" });
});

// 完整 instance_id 和 session_id 的通知必须交给会话监听器。
test("完整会话标识分发协议通知", () => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));
  const message = { type: "relay", instance_id: "instance-1", session_id: "session-1", payload: { sequence: 1 } };

  transport.injectMessage(message);

  expect(received).toEqual([message]);
});

// 缺失 instance_id 的通知不具备会话归属，必须隔离在监听器之外。
test("缺失实例标识不会分发会话通知", () => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));

  transport.injectMessage({ type: "relay", session_id: "session-1" });

  expect(received).toEqual([]);
});

// 缺失 session_id 的通知不具备会话归属，必须隔离在监听器之外。
test("缺失会话标识不会分发会话通知", () => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));

  transport.injectMessage({ type: "relay", instance_id: "instance-1" });

  expect(received).toEqual([]);
});

// 响应即使携带会话字段也应优先完成请求，而不泄露为普通会话通知。
test("请求响应不重复分发为会话通知", async () => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));
  const pending = transport.sendAndWait({ type: "start", request_id: "request-1" });

  transport.injectMessage({
    type: "start_result",
    request_id: "request-1",
    instance_id: "instance-1",
    session_id: "session-1",
  });

  await expect(pending).resolves.toMatchObject({ request_id: "request-1" });
  expect(received).toEqual([]);
});

// 取消订阅后必须移除监听器，防止已关闭会话继续接收消息。
test("取消会话订阅后停止分发", () => {
  const { transport } = createContext();
  const received: TransportMessage[] = [];
  const unsubscribe = transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));

  unsubscribe();
  transport.injectMessage({ type: "relay", instance_id: "instance-1", session_id: "session-1" });

  expect(received).toEqual([]);
});

// 多个订阅者是独立生命周期，移除一个不能影响另一个。
test("取消一个订阅者保留其他订阅者", () => {
  const { transport } = createContext();
  const first: TransportMessage[] = [];
  const second: TransportMessage[] = [];
  const unsubscribeFirst = transport.onSessionMessage((_instanceId, _sessionId, message) => first.push(message));
  transport.onSessionMessage((_instanceId, _sessionId, message) => second.push(message));

  unsubscribeFirst();
  transport.injectMessage({ type: "relay", instance_id: "instance-1", session_id: "session-1" });

  expect(first).toEqual([]);
  expect(second).toEqual([{ type: "relay", instance_id: "instance-1", session_id: "session-1" }]);
});

// 直连模式必须保留宿主原有 onmessage 生命周期链。
test("直连解析保留原始消息处理器", () => {
  const { ws } = createContext(true);

  ws.receive("not-json");

  expect(ws.originalFrames).toEqual(["not-json"]);
});

// 同一 WS 文本帧内的多行 JSON 必须按顺序分别解析与分发。
test("多行文本帧按顺序解析", () => {
  const { transport, ws } = createContext();
  const received: string[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message.type));

  ws.receive(
    `${JSON.stringify({ type: "first", instance_id: "instance-1", session_id: "session-1" })}\n${JSON.stringify({ type: "second", instance_id: "instance-1", session_id: "session-1" })}\n`,
  );

  expect(received).toEqual(["first", "second"]);
});

// 非法 JSON 是不可信协议输入，必须被忽略且不阻断后续合法行。
test("错误协议行不阻断后续合法消息", () => {
  const { transport, ws } = createContext();
  const received: string[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message.type));

  ws.receive(`{bad-json}\n${JSON.stringify({ type: "relay", instance_id: "instance-1", session_id: "session-1" })}`);

  expect(received).toEqual(["relay"]);
});

// Buffer 文本帧必须采用与字符串帧相同的协议解析路径。
test("Buffer 帧解析会话消息", () => {
  const { transport, ws } = createContext();
  const received: TransportMessage[] = [];
  transport.onSessionMessage((_instanceId, _sessionId, message) => received.push(message));

  ws.receive(Buffer.from(JSON.stringify({ type: "relay", instance_id: "instance-1", session_id: "session-1" })));

  expect(received).toEqual([{ type: "relay", instance_id: "instance-1", session_id: "session-1" }]);
});

// 超时必须拒绝请求并清理状态，迟到响应不能改变已经失败的生命周期。
test("超时请求拒绝且忽略迟到响应", async () => {
  const { transport } = createContext();
  const pending = transport.sendAndWait({ type: "relay", request_id: "timeout-request" }, { timeout: 1 });

  await expect(pending).rejects.toThrow("type=relay request_id=timeout-request");
  transport.injectMessage({ type: "relay_result", request_id: "timeout-request" });
});
