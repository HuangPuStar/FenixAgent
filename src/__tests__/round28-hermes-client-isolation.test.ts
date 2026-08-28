import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getHermesClient, HermesClient, initHermesClient } from "../services/hermes-client";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalPlatforms = process.env.HERMES_PLATFORMS;
const clients: HermesClient[] = [];

function createConnectedClient(url = "ws://hermes.invalid/messaging") {
  const client = new HermesClient(url);
  clients.push(client);
  void client.start();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("未创建 WebSocket");
  socket.open();
  return { client, socket };
}

function sentMessages(socket: FakeWebSocket) {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  delete process.env.HERMES_PLATFORMS;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
  if (originalPlatforms === undefined) delete process.env.HERMES_PLATFORMS;
  else process.env.HERMES_PLATFORMS = originalPlatforms;
});

describe("HermesClient 隔离状态、错误与资源释放", () => {
  // 意图：构造函数保留调用方提供的网关地址，避免跨连接串线。
  test("构造函数保留独立网关地址", () => {
    const client = new HermesClient("ws://tenant-a.invalid/ws");
    clients.push(client);
    expect(client.getStatus().url).toBe("ws://tenant-a.invalid/ws");
  });

  // 意图：新客户端在连接前不得误报在线状态。
  test("新客户端初始为离线", () => {
    const client = new HermesClient("ws://hermes.invalid/ws");
    clients.push(client);
    expect(client.getStatus().connected).toBeFalse();
  });

  // 意图：新客户端在连接前不得处于重连状态。
  test("新客户端初始不重连", () => {
    const client = new HermesClient("ws://hermes.invalid/ws");
    clients.push(client);
    expect(client.getStatus().reconnecting).toBeFalse();
  });

  // 意图：新客户端未连接时不应伪造连接时间。
  test("新客户端初始没有连接时间", () => {
    const client = new HermesClient("ws://hermes.invalid/ws");
    clients.push(client);
    expect(client.getStatus().lastConnectedAt).toBeNull();
  });

  // 意图：start 仅构造内存 WebSocket，不访问真实网络。
  test("start 创建一个隔离的 WebSocket", async () => {
    const client = new HermesClient("ws://tenant-a.invalid/ws");
    clients.push(client);
    await client.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  // 意图：连接成功后状态必须变为在线。
  test("打开连接后标记为在线", () => {
    const { client } = createConnectedClient();
    expect(client.getStatus().connected).toBeTrue();
  });

  // 意图：连接成功后清除重连标志。
  test("打开连接后取消重连状态", () => {
    const { client } = createConnectedClient();
    expect(client.getStatus().reconnecting).toBeFalse();
  });

  // 意图：连接成功记录可用的连接时间戳。
  test("打开连接后记录连接时间", () => {
    const { client } = createConnectedClient();
    expect(client.getStatus().lastConnectedAt).not.toBeNull();
  });

  // 意图：连接时向默认平台发送订阅请求。
  test("打开连接订阅默认平台", () => {
    const { socket } = createConnectedClient();
    expect(sentMessages(socket)[0]).toMatchObject({ type: "subscribe" });
  });

  // 意图：默认订阅包含飞书，保证常用渠道可接收消息。
  test("默认订阅包含飞书", () => {
    const { socket } = createConnectedClient();
    expect(sentMessages(socket)[0]?.platforms).toContain("feishu");
  });

  // 意图：默认订阅包含 Telegram，保证常用渠道可接收消息。
  test("默认订阅包含 Telegram", () => {
    const { socket } = createConnectedClient();
    expect(sentMessages(socket)[0]?.platforms).toContain("telegram");
  });

  // 意图：默认订阅包含 Discord，保证常用渠道可接收消息。
  test("默认订阅包含 Discord", () => {
    const { socket } = createConnectedClient();
    expect(sentMessages(socket)[0]?.platforms).toContain("discord");
  });

  // 意图：环境变量平台列表应替代默认列表，隔离部署配置。
  test("环境变量覆盖默认平台列表", () => {
    process.env.HERMES_PLATFORMS = " slack, wecom ";
    const { socket } = createConnectedClient();
    expect(sentMessages(socket)[0]?.platforms).toEqual(["slack", "wecom"]);
  });

  // 意图：空白平台项不能进入订阅请求。
  test("环境变量忽略空白平台项", () => {
    process.env.HERMES_PLATFORMS = "feishu, , telegram,,";
    const { socket } = createConnectedClient();
    expect(sentMessages(socket)[0]?.platforms).toEqual(["feishu", "telegram"]);
  });

  // 意图：空平台配置不发送无效订阅帧。
  test("空平台配置不发送订阅帧", () => {
    process.env.HERMES_PLATFORMS = " , ";
    const { socket } = createConnectedClient();
    expect(socket.sent).toHaveLength(0);
  });

  // 意图：离线状态发送消息必须静默丢弃，避免错误写入。
  test("离线时不发送出站消息", async () => {
    const client = new HermesClient("ws://hermes.invalid/ws");
    clients.push(client);
    await client.start();
    client.send("feishu", "chat-a", "hello");
    expect(FakeWebSocket.instances[0]?.sent).toHaveLength(0);
  });

  // 意图：在线状态发送消息使用协议规定的 send 类型。
  test("在线时发送 send 类型消息", () => {
    const { client, socket } = createConnectedClient();
    client.send("feishu", "chat-a", "hello");
    expect(sentMessages(socket).at(-1)?.type).toBe("send");
  });

  // 意图：出站消息保留目标平台，避免跨平台投递。
  test("出站消息保留平台", () => {
    const { client, socket } = createConnectedClient();
    client.send("slack", "chat-a", "hello");
    expect(sentMessages(socket).at(-1)?.platform).toBe("slack");
  });

  // 意图：出站消息保留目标会话，避免跨会话投递。
  test("出站消息保留会话标识", () => {
    const { client, socket } = createConnectedClient();
    client.send("slack", "chat-private", "hello");
    expect(sentMessages(socket).at(-1)?.chat_id).toBe("chat-private");
  });

  // 意图：出站消息保留正文内容。
  test("出站消息保留正文", () => {
    const { client, socket } = createConnectedClient();
    client.send("slack", "chat-a", "业务回复");
    expect(sentMessages(socket).at(-1)?.content).toBe("业务回复");
  });

  // 意图：未提供 replyTo 时不发送空回复字段。
  test("出站消息省略空回复标识", () => {
    const { client, socket } = createConnectedClient();
    client.send("slack", "chat-a", "hello");
    expect(sentMessages(socket).at(-1)).not.toHaveProperty("reply_to");
  });

  // 意图：提供 replyTo 时消息关联原始会话消息。
  test("出站消息携带回复标识", () => {
    const { client, socket } = createConnectedClient();
    client.send("slack", "chat-a", "hello", "message-a");
    expect(sentMessages(socket).at(-1)?.reply_to).toBe("message-a");
  });

  // 意图：每条出站消息生成独立 ID，防止网关去重冲突。
  test("连续出站消息使用不同 ID", () => {
    const { client, socket } = createConnectedClient();
    client.send("slack", "chat-a", "one");
    client.send("slack", "chat-a", "two");
    const messages = sentMessages(socket).filter((message) => message.type === "send");
    expect(messages[0]?.id).not.toBe(messages[1]?.id);
  });

  // 意图：出站 ID 使用 rcs 前缀以隔离本服务消息。
  test("出站消息 ID 使用 rcs 前缀", () => {
    const { client, socket } = createConnectedClient();
    client.send("slack", "chat-a", "hello");
    expect(sentMessages(socket).at(-1)?.id).toMatch(/^rcs_/);
  });

  // 意图：状态快照不可反向修改内部状态。
  test("状态快照是独立对象", () => {
    const { client } = createConnectedClient();
    const status = client.getStatus();
    status.connected = false;
    expect(client.getStatus().connected).toBeTrue();
  });

  // 意图：状态订阅者在连接成功时得到在线快照。
  test("状态订阅者收到连接事件", () => {
    const client = new HermesClient("ws://hermes.invalid/ws");
    clients.push(client);
    const states: boolean[] = [];
    client.onStatusChange((status) => states.push(status.connected));
    void client.start();
    FakeWebSocket.instances[0]?.open();
    expect(states).toContain(true);
  });

  // 意图：取消状态订阅后不再接收状态变更。
  test("取消状态订阅释放监听器", () => {
    const client = new HermesClient("ws://hermes.invalid/ws");
    clients.push(client);
    let calls = 0;
    const unsubscribe = client.onStatusChange(() => calls++);
    unsubscribe();
    void client.start();
    FakeWebSocket.instances[0]?.open();
    expect(calls).toBe(0);
  });

  // 意图：一个监听器异常不能阻止其他监听器接收状态。
  test("异常状态监听器不会影响其他监听器", () => {
    const client = new HermesClient("ws://hermes.invalid/ws");
    clients.push(client);
    let calls = 0;
    client.onStatusChange(() => {
      throw new Error("listener failed");
    });
    client.onStatusChange(() => calls++);
    void client.start();
    FakeWebSocket.instances[0]?.open();
    expect(calls).toBe(1);
  });

  // 意图：平台连接事件更新在线平台状态。
  test("平台连接事件增加在线平台", () => {
    const { client, socket } = createConnectedClient();
    socket.message('{"type":"platform_status","platform":"feishu","state":"connected"}');
    expect(client.getStatus().platforms).toEqual(["feishu"]);
  });

  // 意图：重复的平台连接事件不得重复记录状态。
  test("重复平台连接不重复记录", () => {
    const { client, socket } = createConnectedClient();
    socket.message('{"type":"platform_status","platform":"feishu","state":"connected"}');
    socket.message('{"type":"platform_status","platform":"feishu","state":"connected"}');
    expect(client.getStatus().platforms).toEqual(["feishu"]);
  });

  // 意图：新平台连接后发送该平台的增量订阅。
  test("新平台连接发送增量订阅", () => {
    const { socket } = createConnectedClient();
    socket.message('{"type":"platform_status","platform":"feishu","state":"connected"}');
    expect(sentMessages(socket).at(-1)).toEqual({ type: "subscribe", platforms: ["feishu"] });
  });

  // 意图：平台断开后从在线平台状态移除。
  test("平台断开事件移除在线平台", () => {
    const { client, socket } = createConnectedClient();
    socket.message('{"type":"platform_status","platform":"feishu","state":"connected"}');
    socket.message('{"type":"platform_status","platform":"feishu","state":"disconnected"}');
    expect(client.getStatus().platforms).toEqual([]);
  });

  // 意图：未知平台断开事件保持现有状态不变。
  test("未知平台断开不影响已有状态", () => {
    const { client, socket } = createConnectedClient();
    socket.message('{"type":"platform_status","platform":"feishu","state":"connected"}');
    socket.message('{"type":"platform_status","platform":"slack","state":"disconnected"}');
    expect(client.getStatus().platforms).toEqual(["feishu"]);
  });

  // 意图：缺少平台字段的状态事件必须安全忽略。
  test("缺少平台字段的状态事件被忽略", () => {
    const { client, socket } = createConnectedClient();
    socket.message('{"type":"platform_status","state":"connected"}');
    expect(client.getStatus().platforms).toEqual([]);
  });

  // 意图：未知平台状态不污染连接状态。
  test("未知平台状态不污染状态", () => {
    const { client, socket } = createConnectedClient();
    socket.message('{"type":"platform_status","platform":"feishu","state":"unknown"}');
    expect(client.getStatus().platforms).toEqual([]);
  });

  // 意图：非法 JSON 输入必须隔离，不能终止连接。
  test("非法 JSON 消息被安全忽略", () => {
    const { client, socket } = createConnectedClient();
    expect(() => socket.message("{")).not.toThrow();
    expect(client.getStatus().connected).toBeTrue();
  });

  // 意图：空行混入消息批次时仍处理有效消息。
  test("多行消息跳过空行", () => {
    const { client, socket } = createConnectedClient();
    socket.message('\n{"type":"platform_status","platform":"feishu","state":"connected"}\n');
    expect(client.getStatus().platforms).toEqual(["feishu"]);
  });

  // 意图：多行消息批次按顺序处理各平台状态。
  test("多行消息按顺序处理", () => {
    const { client, socket } = createConnectedClient();
    socket.message(
      '{"type":"platform_status","platform":"feishu","state":"connected"}\n{"type":"platform_status","platform":"slack","state":"connected"}',
    );
    expect(client.getStatus().platforms).toEqual(["feishu", "slack"]);
  });

  // 意图：pong 在没有超时时仍可安全处理。
  test("pong 消息可安全处理", () => {
    const { socket } = createConnectedClient();
    expect(() => socket.message('{"type":"pong"}')).not.toThrow();
  });

  // 意图：未知协议消息不能影响已建立连接。
  test("未知协议消息不改变连接状态", () => {
    const { client, socket } = createConnectedClient();
    socket.message('{"type":"other"}');
    expect(client.getStatus().connected).toBeTrue();
  });

  // 意图：网关错误消息不能抛到 WebSocket 事件循环。
  test("网关错误消息被安全处理", () => {
    const { socket } = createConnectedClient();
    expect(() => socket.message('{"type":"error","message":"failed"}')).not.toThrow();
  });

  // 意图：失败结果消息不能终止连接处理。
  test("失败结果消息被安全处理", () => {
    const { socket } = createConnectedClient();
    expect(() => socket.message('{"type":"result","success":false,"id":"request-a"}')).not.toThrow();
  });

  // 意图：stop 向在线网关发送取消订阅，释放远端资源。
  test("停止时发送取消订阅", async () => {
    const { client, socket } = createConnectedClient();
    await client.stop();
    expect(sentMessages(socket)).toContainEqual({ type: "unsubscribe" });
  });

  // 意图：stop 关闭在线 socket，释放本地连接资源。
  test("停止时关闭在线 socket", async () => {
    const { client, socket } = createConnectedClient();
    await client.stop();
    expect(socket.readyState).toBe(3);
  });

  // 意图：stop 后状态恢复离线。
  test("停止后标记为离线", async () => {
    const { client } = createConnectedClient();
    await client.stop();
    expect(client.getStatus().connected).toBeFalse();
  });

  // 意图：stop 后取消重连标记，避免已停止客户端自行恢复。
  test("停止后取消重连状态", async () => {
    const { client } = createConnectedClient();
    await client.stop();
    expect(client.getStatus().reconnecting).toBeFalse();
  });

  // 意图：重复 stop 必须幂等，避免资源清理二次失败。
  test("重复停止保持幂等", async () => {
    const { client } = createConnectedClient();
    await client.stop();
    await expect(client.stop()).resolves.toBeUndefined();
  });

  // 意图：关闭事件将在线状态切回离线。
  test("连接关闭后标记为离线", () => {
    const { client, socket } = createConnectedClient();
    socket.disconnect();
    expect(client.getStatus().connected).toBeFalse();
  });

  // 意图：非主动关闭进入重连状态以恢复服务。
  test("非主动关闭进入重连状态", () => {
    const { client, socket } = createConnectedClient();
    socket.disconnect();
    expect(client.getStatus().reconnecting).toBeTrue();
  });

  // 意图：主动停止后的关闭事件不得重新调度连接。
  test("主动停止后关闭不重连", async () => {
    const { client, socket } = createConnectedClient();
    await client.stop();
    socket.disconnect();
    expect(client.getStatus().reconnecting).toBeFalse();
  });

  // 意图：单例初始化返回可查询的当前客户端。
  test("初始化后可获取当前单例", () => {
    const client = initHermesClient("ws://singleton.invalid/ws");
    clients.push(client);
    expect(getHermesClient()).toBe(client);
  });

  // 意图：单例初始化自动启动但仍只使用内存 WebSocket。
  test("单例初始化自动创建连接", () => {
    const client = initHermesClient("ws://singleton.invalid/ws");
    clients.push(client);
    expect(FakeWebSocket.instances[0]?.url).toBe("ws://singleton.invalid/ws");
  });

  // 意图：再次初始化单例使用新的网关地址，避免旧配置残留。
  test("重复初始化替换单例地址", () => {
    const first = initHermesClient("ws://first.invalid/ws");
    const second = initHermesClient("ws://second.invalid/ws");
    clients.push(first, second);
    expect(getHermesClient()?.getStatus().url).toBe("ws://second.invalid/ws");
  });
});
