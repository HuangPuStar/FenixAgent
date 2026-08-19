import { describe, expect, test } from "bun:test";
import type { RelaySocket } from "../relay/relay-handle";
import { createRelayHandle } from "../relay/relay-handle";

interface FakeRelaySocket extends RelaySocket {
  readonly sent: string[];
  readonly closeCalls: Array<{ code?: number; reason?: string }>;
  receive(data: string | Buffer): void;
  open(): void;
  fail(): void;
  disconnect(): void;
}

function createFakeSocket(readyState = 1): FakeRelaySocket {
  const socket: FakeRelaySocket = {
    readyState,
    sent: [],
    closeCalls: [],
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.closeCalls.push({ code, reason });
      this.readyState = 3;
    },
    receive(data) {
      this.onmessage?.({ data });
    },
    open() {
      this.readyState = 1;
      this.onopen?.();
    },
    fail() {
      this.onerror?.();
    },
    disconnect() {
      this.readyState = 3;
      this.onclose?.();
    },
  };
  return socket;
}

function createFixture(options: { readyState?: number; token?: string; port?: number } = {}) {
  const socket = createFakeSocket(options.readyState);
  const handle = createRelayHandle(
    {
      instanceId: "instance-test",
      port: options.port ?? 8123,
      token: options.token ?? "token-test",
    },
    { createWebSocket: () => socket, keepAliveIntervalMs: 60_000 },
  );
  return { handle, socket };
}

describe("CCB relay handle 基础协议", () => {
  // relay URL 必须对 token 编码，避免查询参数被注入或截断。
  test("对 token 中的保留字符进行 URL 编码", () => {
    const { handle } = createFixture({ token: "a b&c?d" });
    expect(handle.url).toBe("ws://127.0.0.1:8123/ws?token=a%20b%26c%3Fd");
    handle.close();
  });

  // relay URL 应使用调用方传入的本地端口。
  test("使用传入的端口构造本地 relay 地址", () => {
    const { handle } = createFixture({ port: 9876 });
    expect(handle.url).toStartWith("ws://127.0.0.1:9876/");
    handle.close();
  });

  // 已打开的 socket 不应阻塞 relay 的 ready 生命周期。
  test("已连接 socket 会立即完成 ready", async () => {
    const { handle } = createFixture();
    await expect(handle.ready).resolves.toBeUndefined();
    handle.close();
  });

  // 未连接 socket 必须等待实际 open 事件后再 ready。
  test("连接中的 socket 在 open 后完成 ready", async () => {
    const { handle, socket } = createFixture({ readyState: 0 });
    let settled = false;
    void handle.ready.then(() => {
      settled = true;
    });

    expect(settled).toBeFalse();
    socket.open();
    await expect(handle.ready).resolves.toBeUndefined();
    expect(settled).toBeTrue();
    handle.close();
  });

  // open 时必须发送 connect 帧，启动 acp-link 协议握手。
  test("open 事件发送 connect 握手帧", () => {
    const { handle, socket } = createFixture({ readyState: 0 });
    socket.open();
    expect(socket.sent).toEqual(['{"type":"connect"}']);
    handle.close();
  });

  // relay 在未关闭前应报告 open 状态。
  test("新建 relay 状态为 open", () => {
    const { handle } = createFixture();
    expect(handle.state).toBe("open");
    handle.close();
  });

  // 业务帧应按原始对象转发给订阅者。
  test("转发单条业务消息", () => {
    const { handle, socket } = createFixture();
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));

    socket.receive('{"type":"assistant","payload":{"text":"你好"}}');
    expect(received).toEqual([{ type: "assistant", payload: { text: "你好" } }]);
    handle.close();
  });

  // 本地 acp-link 可批量换行传输多条 JSON 帧。
  test("按顺序转发换行分隔的多条消息", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"one"}\n{"type":"two"}\n{"type":"three"}');
    expect(received).toEqual(["one", "two", "three"]);
    handle.close();
  });

  // 空行不是协议帧，不应影响相邻的有效消息。
  test("忽略消息批次中的空行", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('\n{"type":"first"}\n\n{"type":"last"}\n');
    expect(received).toEqual(["first", "last"]);
    handle.close();
  });

  // Bun websocket 可能提供 Buffer，relay 应使用同一解析路径。
  test("解析 Buffer 形式的业务消息", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive(Buffer.from('{"type":"buffered"}'));
    expect(received).toEqual(["buffered"]);
    handle.close();
  });

  // 损坏帧来自本地进程时必须隔离，避免断开整个 relay。
  test("忽略损坏 JSON 并继续处理后续帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{not-json}\n{"type":"recover"}');
    expect(received).toEqual(["recover"]);
    handle.close();
  });

  // keep_alive 是传输层噪音，不得泄漏到上层业务订阅者。
  test("过滤 keep_alive 入站帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"keep_alive"}');
    expect(received).toEqual([]);
    handle.close();
  });

  // pong 是 keepalive 的应答，不是业务消息。
  test("过滤 pong 入站帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"pong"}');
    expect(received).toEqual([]);
    handle.close();
  });

  // acp-link 对 keepalive 的错误回报同样属于传输噪音。
  test("过滤包含 keep_alive 的错误帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"error","payload":{"message":"keep_alive timeout"}}');
    expect(received).toEqual([]);
    handle.close();
  });

  // 非 keepalive 错误携带可诊断信息，必须交给上层处理。
  test("转发普通错误帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"error","payload":{"message":"permission denied"}}');
    expect(received).toEqual(["error"]);
    handle.close();
  });

  // 错误 payload 不含 message 时不能误判为 keepalive 噪音。
  test("转发缺少 message 的错误帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"error","payload":{}}');
    expect(received).toEqual(["error"]);
    handle.close();
  });

  // 字符串 payload 不是 keepalive 错误结构，应保持协议透明。
  test("转发字符串 payload 的错误帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"error","payload":"keep_alive timeout"}');
    expect(received).toEqual(["error"]);
    handle.close();
  });

  // 未知消息类型需要透传，以便协议可以向前兼容。
  test("转发未知的协议消息类型", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    socket.receive('{"type":"future_protocol_event","payload":42}');
    expect(received).toEqual(["future_protocol_event"]);
    handle.close();
  });

  // 监听器注册前的状态帧必须缓存，避免 ready 回调竞态丢消息。
  test("缓存首个监听器注册前的业务帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    socket.receive('{"type":"status","payload":{"ready":true}}');

    handle.onMessage((message) => received.push(message.type));
    expect(received).toEqual(["status"]);
    handle.close();
  });

  // 缓冲区必须维持消息到达顺序。
  test("按到达顺序回放预注册缓冲帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    socket.receive('{"type":"one"}\n{"type":"two"}');

    handle.onMessage((message) => received.push(message.type));
    expect(received).toEqual(["one", "two"]);
    handle.close();
  });

  // 噪音帧不能占据业务缓冲区。
  test("不缓存监听器注册前的 keepalive 帧", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    socket.receive('{"type":"keep_alive"}\n{"type":"business"}');

    handle.onMessage((message) => received.push(message.type));
    expect(received).toEqual(["business"]);
    handle.close();
  });

  // 缓冲只属于首次订阅的建立过程，不能被后加入的订阅者重复消费。
  test("第二个监听器不会重放已消费缓冲帧", () => {
    const { handle, socket } = createFixture();
    const first: string[] = [];
    const second: string[] = [];
    socket.receive('{"type":"cached"}');

    handle.onMessage((message) => first.push(message.type));
    handle.onMessage((message) => second.push(message.type));
    expect(first).toEqual(["cached"]);
    expect(second).toEqual([]);
    handle.close();
  });

  // 多订阅者均应获得后续业务帧。
  test("向所有活跃监听器广播业务帧", () => {
    const { handle, socket } = createFixture();
    const first: string[] = [];
    const second: string[] = [];
    handle.onMessage((message) => first.push(message.type));
    handle.onMessage((message) => second.push(message.type));

    socket.receive('{"type":"broadcast"}');
    expect(first).toEqual(["broadcast"]);
    expect(second).toEqual(["broadcast"]);
    handle.close();
  });

  // 取消订阅后，该监听器不得再接收后续帧。
  test("取消订阅会停止向该监听器投递", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    const unsubscribe = handle.onMessage((message) => received.push(message.type));
    unsubscribe();

    socket.receive('{"type":"after_unsubscribe"}');
    expect(received).toEqual([]);
    handle.close();
  });

  // 一个订阅者退出不能影响其他订阅者。
  test("取消一个监听器不会影响其他监听器", () => {
    const { handle, socket } = createFixture();
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribe = handle.onMessage((message) => first.push(message.type));
    handle.onMessage((message) => second.push(message.type));
    unsubscribe();

    socket.receive('{"type":"remaining"}');
    expect(first).toEqual([]);
    expect(second).toEqual(["remaining"]);
    handle.close();
  });

  // 监听器全部移除后，新帧应再次进入缓冲区供下次订阅回放。
  test("所有监听器移除后重新缓冲业务帧", () => {
    const { handle, socket } = createFixture();
    const first: string[] = [];
    const unsubscribe = handle.onMessage((message) => first.push(message.type));
    unsubscribe();
    socket.receive('{"type":"rebuffered"}');
    const second: string[] = [];

    handle.onMessage((message) => second.push(message.type));
    expect(first).toEqual([]);
    expect(second).toEqual(["rebuffered"]);
    handle.close();
  });

  // 业务 send 必须采用 JSON 序列化并写入 socket。
  test("序列化并发送业务消息", () => {
    const { handle, socket } = createFixture();
    handle.send({ type: "prompt", payload: { text: "hello" } });

    expect(socket.sent).toEqual(['{"type":"prompt","payload":{"text":"hello"}}']);
    handle.close();
  });

  // 发送 ping 是本地 liveness 检查，不应实际写 socket。
  test("发送 ping 时在本地回送 pong", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    handle.send({ type: "ping" });
    expect(received).toEqual([]);
    expect(socket.sent).toEqual([]);
    handle.close();
  });

  // 本地 pong 同样是传输噪音，不应被订阅者观察到。
  test("本地 ping 产生的 pong 不会泄漏给订阅者", () => {
    const { handle } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));

    handle.send({ type: "ping" });
    expect(received).toEqual([]);
    handle.close();
  });

  // close 必须转发调用方提供的关闭上下文。
  test("关闭时传递 code 和 reason", () => {
    const { handle, socket } = createFixture();
    handle.close(4001, "session ended");

    expect(socket.closeCalls).toEqual([{ code: 4001, reason: "session ended" }]);
  });

  // 主动关闭后状态应立即变化，避免再次发送协议帧。
  test("主动关闭后状态为 closed", () => {
    const { handle } = createFixture();
    handle.close();

    expect(handle.state).toBe("closed");
  });

  // close 必须幂等，防止多个清理路径重复关闭底层连接。
  test("重复关闭只调用一次 socket.close", () => {
    const { handle, socket } = createFixture();
    handle.close();
    handle.close();

    expect(socket.closeCalls).toHaveLength(1);
  });

  // 已关闭 relay 不得继续发送，避免写入失效连接。
  test("关闭后发送消息会抛出错误", () => {
    const { handle } = createFixture();
    handle.close();

    expect(() => handle.send({ type: "prompt" })).toThrow("Relay is closed");
  });

  // 远端关闭要通知订阅者进入可恢复的断连状态。
  test("远端关闭时广播 relay_closed", () => {
    const { handle, socket } = createFixture();
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));
    socket.disconnect();

    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_disconnected" } }]);
    expect(handle.state).toBe("closed");
  });

  // 远端错误应使用与普通关闭不同的诊断代码。
  test("socket 错误时广播 relay_error", () => {
    const { handle, socket } = createFixture();
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));
    socket.fail();

    expect(received).toEqual([{ type: "relay_closed", payload: { code: "relay_error" } }]);
    expect(handle.state).toBe("closed");
  });

  // 关闭时必须丢弃尚未订阅的业务缓冲，防止旧会话数据泄漏。
  test("远端关闭会清理未消费的消息缓冲", () => {
    const { handle, socket } = createFixture();
    socket.receive('{"type":"stale"}');
    socket.disconnect();
    const received: string[] = [];

    handle.onMessage((message) => received.push(message.type));
    expect(received).toEqual([]);
  });

  // 错误时同样需要释放未消费的消息缓冲。
  test("socket 错误会清理未消费的消息缓冲", () => {
    const { handle, socket } = createFixture();
    socket.receive('{"type":"stale"}');
    socket.fail();
    const received: string[] = [];

    handle.onMessage((message) => received.push(message.type));
    expect(received).toEqual([]);
  });

  // 已关闭 relay 收到迟到帧时不得重新打开状态。
  test("关闭后的迟到业务帧不会恢复 relay 状态", () => {
    const { handle, socket } = createFixture();
    handle.close();
    socket.receive('{"type":"late"}');

    expect(handle.state).toBe("closed");
  });

  // ready 已完成后再收到关闭不应反向改变已完成的 Promise。
  test("ready 完成后关闭不会使 ready 失败", async () => {
    const { handle, socket } = createFixture();
    await handle.ready;
    socket.disconnect();

    await expect(handle.ready).resolves.toBeUndefined();
  });

  // 业务帧的 payload 可以为空，relay 不应篡改协议结构。
  test("转发没有 payload 的业务帧", () => {
    const { handle, socket } = createFixture();
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));

    socket.receive('{"type":"notification"}');
    expect(received).toEqual([{ type: "notification" }]);
    handle.close();
  });

  // 同一监听器重复注册在 Set 中只能保留一份，避免重复执行副作用。
  test("重复注册同一监听器只投递一次", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    const listener = (message: { type: string }) => received.push(message.type);
    handle.onMessage(listener);
    handle.onMessage(listener);

    socket.receive('{"type":"once"}');
    expect(received).toEqual(["once"]);
    handle.close();
  });

  // close 未提供上下文时仍应关闭 socket，兼容默认清理路径。
  test("默认关闭会调用 socket.close", () => {
    const { handle, socket } = createFixture();
    handle.close();

    expect(socket.closeCalls).toEqual([{ code: undefined, reason: undefined }]);
  });

  // 关闭后本地 ping 也必须被拒绝，避免错误地模拟活跃连接。
  test("关闭后发送 ping 会抛出错误", () => {
    const { handle } = createFixture();
    handle.close();

    expect(() => handle.send({ type: "ping" })).toThrow("Relay is closed");
  });

  // 含额外字段的错误帧应保留，方便上层获得完整诊断上下文。
  test("保留普通错误帧的完整 payload", () => {
    const { handle, socket } = createFixture();
    const received: unknown[] = [];
    handle.onMessage((message) => received.push(message));

    socket.receive('{"type":"error","payload":{"message":"failed","code":"E_FAIL"}}');
    expect(received).toEqual([{ type: "error", payload: { message: "failed", code: "E_FAIL" } }]);
    handle.close();
  });

  // 协议错误大小写敏感，只有约定的 keep_alive 标识才会被过滤。
  test("不误过滤大小写不同的错误信息", () => {
    const { handle, socket } = createFixture();
    const received: string[] = [];
    handle.onMessage((message) => received.push(message.type));
    socket.receive('{"type":"error","payload":{"message":"KEEP_ALIVE timeout"}}');

    expect(received).toEqual(["error"]);
    handle.close();
  });
});
