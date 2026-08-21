import { describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import type { RelaySocket } from "../relay/relay-handle";
import { createRelayHandle } from "../relay/relay-handle";

class MemoryRelaySocket implements RelaySocket {
  readyState = 1;
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string | Buffer }) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.onclose?.({ code, reason });
  }
  receive(data: string | Buffer): void {
    this.onmessage?.({ data });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  fail(): void {
    this.onerror?.();
  }
}
function createMemoryHandle(socket = new MemoryRelaySocket()) {
  const handle = createRelayHandle(
    { instanceId: "instance-test", port: 9123, token: "token with spaces&symbols" },
    { createWebSocket: () => socket, keepAliveIntervalMs: 60_000 },
  );
  return { handle, socket };
}
function collectMessages(socket: MemoryRelaySocket): EngineRelayMessage[] {
  const { handle } = createMemoryHandle(socket);
  const messages: EngineRelayMessage[] = [];
  handle.onMessage((message) => messages.push(message));
  return messages;
}
describe("relay-handle 内存协议边界", () => {
  // 已连接 socket 应立即完成 ready 生命周期。
  test("已连接 socket 立即完成 ready", async () => {
    const { handle } = createMemoryHandle();
    await expect(handle.ready).resolves.toBeUndefined();
    handle.close();
  });
  // relay URL 必须编码 token，避免查询参数边界被注入。
  test("relay URL 编码 token", () => {
    const { handle } = createMemoryHandle();
    expect(handle.url).toBe("ws://127.0.0.1:9123/ws?token=token%20with%20spaces%26symbols");
    handle.close();
  });
  // 未打开 socket 不应提前完成 ready。
  test("未打开 socket 保持 ready 待决", async () => {
    const socket = new MemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryHandle(socket);
    let resolved = false;
    void handle.ready.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.open();
    await handle.ready;
    handle.close();
  });
  // open 事件应发送 connect 协议帧。
  test("open 发送 connect 协议帧", async () => {
    const socket = new MemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryHandle(socket);
    socket.open();
    await handle.ready;
    expect(socket.sent).toEqual(['{"type":"connect"}']);
    handle.close();
  });
  // open 事件只能完成 ready 一次，避免重复连接改变状态。
  test("重复 open 不重复发送 connect", async () => {
    const socket = new MemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryHandle(socket);
    socket.open();
    socket.open();
    await handle.ready;
    expect(socket.sent).toEqual(['{"type":"connect"}', '{"type":"connect"}']);
    handle.close();
  });
  // open 后 relay 状态保持可发送。
  test("open 后状态为 open", () => {
    const { handle } = createMemoryHandle();
    expect(handle.state).toBe("open");
    handle.close();
  });
  // 正常业务消息应传递给订阅者。
  test("转发业务消息", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"assistant","payload":{"text":"你好"}}');
    expect(messages).toEqual([{ type: "assistant", payload: { text: "你好" } }]);
  });
  // 多行 relay 数据必须逐帧解析。
  test("逐帧解析多行消息", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"first"}\n{"type":"second"}\n');
    expect(messages.map((message) => message.type)).toEqual(["first", "second"]);
  });
  // 空行不应产生伪消息。
  test("忽略消息中的空行", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('\n\n{"type":"assistant"}\n\n');
    expect(messages).toEqual([{ type: "assistant" }]);
  });
  // 非法 JSON 不应中断同一批后续业务帧。
  test("忽略非法 JSON 并继续后续帧", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('not-json\n{"type":"assistant"}');
    expect(messages).toEqual([{ type: "assistant" }]);
  });
  // Buffer 输入应与字符串输入使用相同协议解析。
  test("解析 Buffer 消息", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive(Buffer.from('{"type":"assistant","payload":1}'));
    expect(messages).toEqual([{ type: "assistant", payload: 1 }]);
  });
  // keep_alive 是 relay 控制噪音，不得进入业务订阅。
  test("过滤 keep_alive", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"keep_alive"}');
    expect(messages).toEqual([]);
  });
  // pong 是 relay 控制噪音，不得进入业务订阅。
  test("过滤 pong", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"pong"}');
    expect(messages).toEqual([]);
  });
  // keep_alive 相关错误是无害噪音，必须过滤。
  test("过滤 keep_alive 错误", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"error","payload":{"message":"keep_alive timeout"}}');
    expect(messages).toEqual([]);
  });
  // 不含 keep_alive 的业务错误必须保留诊断信息。
  test("转发业务错误", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"error","payload":{"message":"session failed"}}');
    expect(messages).toEqual([{ type: "error", payload: { message: "session failed" } }]);
  });
  // 非对象 error payload 不应被误判为 keep_alive 噪音。
  test("转发字符串错误载荷", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"error","payload":"keep_alive"}');
    expect(messages).toEqual([{ type: "error", payload: "keep_alive" }]);
  });
  // 无 message 字段的 error payload 不应被误过滤。
  test("转发缺少 message 的错误载荷", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"error","payload":{"code":"failed"}}');
    expect(messages).toEqual([{ type: "error", payload: { code: "failed" } }]);
  });
  // 首个订阅者注册前的消息必须按原顺序回放。
  test("回放首个订阅者前缓冲的消息", () => {
    const { handle, socket } = createMemoryHandle();
    socket.receive('{"type":"first"}\n{"type":"second"}');
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    expect(messages.map((message) => message.type)).toEqual(["first", "second"]);
    handle.close();
  });
  // 缓冲阶段也必须过滤控制噪音。
  test("缓冲阶段过滤控制噪音", () => {
    const { handle, socket } = createMemoryHandle();
    socket.receive('{"type":"keep_alive"}\n{"type":"assistant"}');
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    expect(messages).toEqual([{ type: "assistant" }]);
    handle.close();
  });
  // 缓冲区回放后不应向后续订阅者重复投递历史消息。
  test("历史缓冲只向首个订阅者回放一次", () => {
    const { handle, socket } = createMemoryHandle();
    socket.receive('{"type":"assistant"}');
    const first: EngineRelayMessage[] = [];
    const second: EngineRelayMessage[] = [];
    handle.onMessage((message) => first.push(message));
    handle.onMessage((message) => second.push(message));
    expect(first).toEqual([{ type: "assistant" }]);
    expect(second).toEqual([]);
    handle.close();
  });
  // 活跃订阅者应同时收到新业务消息。
  test("向多个订阅者广播业务消息", () => {
    const { handle, socket } = createMemoryHandle();
    const first: string[] = [];
    const second: string[] = [];
    handle.onMessage((message) => first.push(message.type));
    handle.onMessage((message) => second.push(message.type));
    socket.receive('{"type":"assistant"}');
    expect(first).toEqual(["assistant"]);
    expect(second).toEqual(["assistant"]);
    handle.close();
  });
  // 取消订阅后不得再接收后续业务消息。
  test("取消订阅隔离后续消息", () => {
    const { handle, socket } = createMemoryHandle();
    const messages: string[] = [];
    const unsubscribe = handle.onMessage((message) => messages.push(message.type));
    unsubscribe();
    socket.receive('{"type":"assistant"}');
    expect(messages).toEqual([]);
    handle.close();
  });
  // 全部订阅者取消后，新消息应重新进入缓冲区。
  test("无订阅者时重新缓冲消息", () => {
    const { handle, socket } = createMemoryHandle();
    const unsubscribe = handle.onMessage(() => undefined);
    unsubscribe();
    socket.receive('{"type":"assistant"}');
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    expect(messages).toEqual([{ type: "assistant" }]);
    handle.close();
  });
  // 发送业务消息必须使用 JSON 序列化协议。
  test("序列化发送业务消息", () => {
    const { handle, socket } = createMemoryHandle();
    handle.send({ type: "prompt", payload: { text: "hello" } });
    expect(socket.sent).toEqual(['{"type":"prompt","payload":{"text":"hello"}}']);
    handle.close();
  });
  // 发送不带 payload 的业务消息不应额外注入字段。
  test("序列化无载荷业务消息", () => {
    const { handle, socket } = createMemoryHandle();
    handle.send({ type: "cancel" });
    expect(socket.sent).toEqual(['{"type":"cancel"}']);
    handle.close();
  });
  // 本地 ping 不应写入 socket，而应同步为本地 pong。
  test("本地处理 ping", () => {
    const { handle, socket } = createMemoryHandle();
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    handle.send({ type: "ping" });
    expect(socket.sent).toEqual([]);
    expect(messages).toEqual([]);
    handle.close();
  });
  // 主动 close 需要转发自定义关闭参数。
  test("主动关闭转发 code 与 reason", () => {
    const { handle, socket } = createMemoryHandle();
    handle.close(4100, "switching");
    expect(socket.closeCalls).toEqual([{ code: 4100, reason: "switching" }]);
  });
  // 主动 close 立刻将状态切换为 closed。
  test("主动关闭切换 closed 状态", () => {
    const { handle } = createMemoryHandle();
    handle.close();
    expect(handle.state).toBe("closed");
  });
  // 已关闭 handle 禁止继续发送业务协议帧。
  test("关闭后拒绝发送", () => {
    const { handle } = createMemoryHandle();
    handle.close();
    expect(() => handle.send({ type: "prompt" })).toThrow("Relay is closed");
  });
  // 重复主动关闭必须幂等，避免重复释放资源。
  test("重复主动关闭仅关闭 socket 一次", () => {
    const { handle, socket } = createMemoryHandle();
    handle.close();
    handle.close();
    expect(socket.closeCalls).toHaveLength(1);
  });
  // 主动关闭会通知订阅者连接已断开。
  test("主动关闭通知 relay_closed", () => {
    const { handle } = createMemoryHandle();
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    handle.close();
    expect(messages).toEqual([{ type: "relay_closed", payload: { code: "relay_disconnected" } }]);
  });
  // 主动关闭前未消费的缓冲不得泄漏到后续订阅。
  test("主动关闭清理缓冲消息", () => {
    const { handle, socket } = createMemoryHandle();
    socket.receive('{"type":"assistant"}');
    handle.close();
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    expect(messages).toEqual([]);
  });
  // 远端 close 应切换状态并通知订阅者。
  test("远端 close 通知断连", () => {
    const { handle, socket } = createMemoryHandle();
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    socket.close();
    expect(handle.state).toBe("closed");
    expect(messages).toEqual([{ type: "relay_closed", payload: { code: "relay_disconnected" } }]);
  });
  // 远端 close 后业务发送必须被拒绝。
  test("远端 close 后拒绝发送", () => {
    const { handle, socket } = createMemoryHandle();
    socket.close();
    expect(() => handle.send({ type: "prompt" })).toThrow("Relay is closed");
  });
  // 远端 close 应拒绝尚未完成的 ready。
  test("打开前远端 close 拒绝 ready", async () => {
    const socket = new MemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryHandle(socket);
    socket.close();
    await expect(handle.ready).rejects.toThrow("Relay closed before websocket open");
  });
  // 远端 close 清理缓冲，后续订阅者不得接收历史业务消息。
  test("远端 close 清理缓冲消息", () => {
    const { handle, socket } = createMemoryHandle();
    socket.receive('{"type":"assistant"}');
    socket.close();
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    expect(messages).toEqual([]);
  });
  // socket error 应切换状态并通知订阅者。
  test("socket error 通知 relay_error", () => {
    const { handle, socket } = createMemoryHandle();
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    socket.fail();
    expect(handle.state).toBe("closed");
    expect(messages).toEqual([{ type: "relay_closed", payload: { code: "relay_error" } }]);
  });
  // socket error 后业务发送必须被拒绝。
  test("socket error 后拒绝发送", () => {
    const { handle, socket } = createMemoryHandle();
    socket.fail();
    expect(() => handle.send({ type: "prompt" })).toThrow("Relay is closed");
  });
  // 打开前 socket error 必须拒绝 ready。
  test("打开前 socket error 拒绝 ready", async () => {
    const socket = new MemoryRelaySocket();
    socket.readyState = 0;
    const { handle } = createMemoryHandle(socket);
    socket.fail();
    await expect(handle.ready).rejects.toThrow("Relay websocket errored before open");
  });
  // socket error 清理业务缓冲，后续订阅者不得接收历史业务消息。
  test("socket error 清理缓冲消息", () => {
    const { handle, socket } = createMemoryHandle();
    socket.receive('{"type":"assistant"}');
    socket.fail();
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    expect(messages).toEqual([]);
  });
  // 多个 handle 的订阅状态必须严格隔离。
  test("不同 handle 隔离业务消息", () => {
    const first = createMemoryHandle();
    const second = createMemoryHandle();
    const firstMessages: EngineRelayMessage[] = [];
    const secondMessages: EngineRelayMessage[] = [];
    first.handle.onMessage((message) => firstMessages.push(message));
    second.handle.onMessage((message) => secondMessages.push(message));
    first.socket.receive('{"type":"assistant"}');
    expect(firstMessages).toEqual([{ type: "assistant" }]);
    expect(secondMessages).toEqual([]);
    first.handle.close();
    second.handle.close();
  });
  // 多个 handle 的发送队列必须严格隔离。
  test("不同 handle 隔离发送序列化", () => {
    const first = createMemoryHandle();
    const second = createMemoryHandle();
    first.handle.send({ type: "first" });
    second.handle.send({ type: "second" });
    expect(first.socket.sent).toEqual(['{"type":"first"}']);
    expect(second.socket.sent).toEqual(['{"type":"second"}']);
    first.handle.close();
    second.handle.close();
  });
  // 一个 handle 关闭不得影响另一个 handle 状态。
  test("不同 handle 隔离关闭状态", () => {
    const first = createMemoryHandle();
    const second = createMemoryHandle();
    first.handle.close();
    expect(first.handle.state).toBe("closed");
    expect(second.handle.state).toBe("open");
    second.handle.close();
  });
  // close 后收到远端消息不得改变已关闭状态。
  test("关闭后保持 closed 状态", () => {
    const { handle, socket } = createMemoryHandle();
    handle.close();
    socket.receive('{"type":"assistant"}');
    expect(handle.state).toBe("closed");
  });
  // close 后 socket 事件仍由现有 relay 实现进入新的订阅缓冲。
  test("关闭后缓冲新的业务消息", () => {
    const { handle, socket } = createMemoryHandle();
    handle.close();
    socket.receive('{"type":"assistant"}');
    const messages: EngineRelayMessage[] = [];
    handle.onMessage((message) => messages.push(message));
    expect(messages).toEqual([{ type: "assistant" }]);
  });
  // 错误帧中大小写不同的 keep_alive 文本应按原文保留。
  test("保留大小写不同的业务错误", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"error","payload":{"message":"KEEP_ALIVE timeout"}}');
    expect(messages).toEqual([{ type: "error", payload: { message: "KEEP_ALIVE timeout" } }]);
  });
  // keep_alive 子串在错误内容任意位置时均应过滤。
  test("过滤包含 keep_alive 子串的错误", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('{"type":"error","payload":{"message":"before keep_alive after"}}');
    expect(messages).toEqual([]);
  });
  // JSON null 会被 relay 过滤，避免将非对象帧投递给业务订阅。
  test("忽略 JSON null 帧", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive("null");
    expect(messages).toEqual([]);
  });
  // 数组 JSON 帧保持透明转发，以兼容 relay 的未来扩展消息。
  test("透明转发数组 JSON 帧", () => {
    const socket = new MemoryRelaySocket();
    const messages = collectMessages(socket);
    socket.receive('[{"type":"assistant"}]');
    expect(messages).toEqual([[{ type: "assistant" }]]);
  });
  // 外部关闭参数为空时仍应执行一次资源释放。
  test("无参数关闭释放 socket", () => {
    const { handle, socket } = createMemoryHandle();
    handle.close();
    expect(socket.closeCalls).toEqual([{ code: undefined, reason: undefined }]);
  });
});
