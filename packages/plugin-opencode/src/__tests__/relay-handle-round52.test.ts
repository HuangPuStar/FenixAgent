import { describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { createRelayHandle, type RelaySocket } from "../relay/relay-handle";

class InMemoryRelaySocket implements RelaySocket {
  readyState = 1;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string | Buffer }) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: string | Buffer): void {
    this.onmessage?.({ data });
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "lost" });
  }

  fail(): void {
    this.onerror?.(new Error("memory socket failed"));
  }
}

function createMemoryRelay(instanceId = "session-a", socket = new InMemoryRelaySocket()) {
  const urls: string[] = [];
  const handle = createRelayHandle(
    { instanceId, port: 9731, token: "token/a?&" },
    {
      createWebSocket(url) {
        urls.push(url);
        return socket;
      },
      keepAliveIntervalMs: 60_000,
    },
  );
  return { handle, socket, urls };
}

describe("relay-handle round52 内存协议", () => {
  // 创建连接时必须把 token 编码后交给 socket 工厂。
  test("创建时使用编码后的本地 relay URL", () => {
    const { handle, urls } = createMemoryRelay();
    expect(urls).toEqual(["ws://127.0.0.1:9731/ws?token=token%2Fa%3F%26"]);
    expect(handle.url).toBe(urls[0]);
    handle.close();
  });

  // 未 open 的连接只在 open 事件到达后完成 ready。
  test("open 完成待决 ready 并发送 connect", async () => {
    const socket = new InMemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryRelay("session-a", socket);
    let settled = false;
    void handle.ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.open();
    await expect(handle.ready).resolves.toBeUndefined();
    expect(socket.sent).toEqual(['{"type":"connect"}']);
    handle.close();
  });

  // 已连接 socket 不需要等待额外的 open 回调。
  test("已连接 socket 立即完成 ready", async () => {
    const socket = new InMemoryRelaySocket();
    socket.readyState = 1;
    const { handle } = createMemoryRelay("ready-now", socket);
    await expect(handle.ready).resolves.toBeUndefined();
    handle.close();
  });

  // 请求 ID 必须原样保留在发送的业务帧中。
  test("发送业务消息保留 requestId", () => {
    const { handle, socket } = createMemoryRelay();
    handle.send({ type: "request", payload: { requestId: "req-52", method: "prompt" } });
    expect(socket.sent).toEqual(['{"type":"request","payload":{"requestId":"req-52","method":"prompt"}}']);
    handle.close();
  });

  // 入站响应的请求 ID 必须完整转发给订阅者。
  test("转发入站 response 的 requestId", () => {
    const { handle, socket } = createMemoryRelay();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    socket.receive('{"type":"response","payload":{"requestId":"req-52","result":"ok"}}');
    expect(received).toEqual([{ type: "response", payload: { requestId: "req-52", result: "ok" } }]);
    handle.close();
  });

  // session 标识属于透明协议载荷，不能被 relay 混淆或改写。
  test("转发 sessionId 与嵌套消息内容", () => {
    const { handle, socket } = createMemoryRelay();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    socket.receive('{"type":"event","payload":{"sessionId":"session-52","message":{"id":"msg-1"}}}');
    expect(received).toEqual([{ type: "event", payload: { sessionId: "session-52", message: { id: "msg-1" } } }]);
    handle.close();
  });

  // 同一数据块中的多个请求响应必须按线序投递。
  test("按顺序解析多条带 requestId 的帧", () => {
    const { handle, socket } = createMemoryRelay();
    const ids: string[] = [];
    handle.onMessage((message) => ids.push((message.payload as { requestId: string }).requestId));
    socket.receive(
      '{"type":"response","payload":{"requestId":"one"}}\n{"type":"response","payload":{"requestId":"two"}}',
    );
    expect(ids).toEqual(["one", "two"]);
    handle.close();
  });

  // Buffer 承载的真实 relay 帧也必须被解码并投递。
  test("解析 Buffer 中的业务帧", () => {
    const { handle, socket } = createMemoryRelay();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    socket.receive(Buffer.from('{"type":"delta","payload":{"sessionId":"buffer-session"}}'));
    expect(received).toEqual([{ type: "delta", payload: { sessionId: "buffer-session" } }]);
    handle.close();
  });

  // 非法帧不能阻止同批后续有效响应。
  test("忽略非法 JSON 后继续处理响应", () => {
    const { handle, socket } = createMemoryRelay();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    socket.receive('bad-frame\n{"type":"response","payload":{"requestId":"after-bad"}}');
    expect(received).toEqual([{ type: "response", payload: { requestId: "after-bad" } }]);
    handle.close();
  });

  // keep_alive 控制帧不得泄漏到 session 业务订阅。
  test("过滤 keep_alive 控制帧", () => {
    const { handle, socket } = createMemoryRelay();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    socket.receive('{"type":"keep_alive"}');
    expect(received).toEqual([]);
    handle.close();
  });

  // 本地 ping 只产生被过滤的 pong，不能写入 socket。
  test("本地 ping 不发送网络帧", () => {
    const { handle, socket } = createMemoryRelay();
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    handle.send({ type: "ping" });
    expect(socket.sent).toEqual([]);
    expect(received).toEqual([]);
    handle.close();
  });

  // 首个订阅者注册前的 session 事件应被缓冲后回放。
  test("回放订阅前缓冲的 session 消息", () => {
    const { handle, socket } = createMemoryRelay();
    socket.receive('{"type":"event","payload":{"sessionId":"late-session"}}');
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    expect(received).toEqual([{ type: "event", payload: { sessionId: "late-session" } }]);
    handle.close();
  });

  // 取消一个 session 订阅不得取消其他订阅者。
  test("取消订阅隔离其他订阅者", () => {
    const { handle, socket } = createMemoryRelay();
    const first: EngineRelayMessage[] = [];
    const second: EngineRelayMessage[] = [];
    const unsubscribe = handle.onMessage((message) => first.push(message));
    handle.onMessage((message) => second.push(message));
    unsubscribe();
    socket.receive('{"type":"event","payload":{"sessionId":"active"}}');
    expect(first).toEqual([]);
    expect(second).toEqual([{ type: "event", payload: { sessionId: "active" } }]);
    handle.close();
  });

  // 两个 handle 的 session 流必须互不串扰。
  test("不同 handle 隔离 session 消息", () => {
    const first = createMemoryRelay("instance-one");
    const second = createMemoryRelay("instance-two");
    const firstReceived: EngineRelayMessage[] = [];
    const secondReceived: EngineRelayMessage[] = [];
    first.handle.onMessage((message) => firstReceived.push(message));
    second.handle.onMessage((message) => secondReceived.push(message));
    first.socket.receive('{"type":"event","payload":{"sessionId":"only-first"}}');
    expect(firstReceived).toEqual([{ type: "event", payload: { sessionId: "only-first" } }]);
    expect(secondReceived).toEqual([]);
    first.handle.close();
    second.handle.close();
  });

  // open 前的远端关闭必须拒绝 ready 并发布断连事件。
  test("open 前关闭拒绝 ready 并通知断连", async () => {
    const socket = new InMemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryRelay("session-a", socket);
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    socket.disconnect();
    await expect(handle.ready).rejects.toThrow("Relay closed before websocket open");
    expect(handle.state).toBe("closed");
    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_disconnected" } }]);
  });

  // socket 错误必须拒绝 ready 并提供错误断连语义。
  test("open 前错误拒绝 ready 并通知 relay_error", async () => {
    const socket = new InMemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryRelay("session-a", socket);
    const received: EngineRelayMessage[] = [];
    handle.onMessage((message) => received.push(message));
    socket.fail();
    await expect(handle.ready).rejects.toThrow("Relay websocket errored before open");
    expect(handle.state).toBe("closed");
    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_error" } }]);
  });

  // 主动关闭应保留关闭参数且阻止后续业务请求。
  test("主动关闭转发参数并拒绝后续发送", () => {
    const { handle, socket } = createMemoryRelay();
    handle.close(4101, "session finished");
    expect(socket.closeCalls).toEqual([{ code: 4101, reason: "session finished" }]);
    expect(() => handle.send({ type: "request", payload: { requestId: "after-close" } })).toThrow("Relay is closed");
  });
});
