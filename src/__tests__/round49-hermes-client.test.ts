import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { eventService } from "../services/event-service";
import { HermesClient } from "../services/hermes-client";

class MemoryWebSocket {
  static instances: MemoryWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    MemoryWebSocket.instances.push(this);
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

  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

type HermesClientInternals = {
  ensureOutboundRouting(platform: string, chatId: string, agentId: string, replyTo?: string): void;
};

const originalWebSocket = globalThis.WebSocket;
const clients: HermesClient[] = [];
const agentIds: string[] = [];
let nextAgent = 0;

function connectClient(): { client: HermesClient; socket: MemoryWebSocket } {
  const client = new HermesClient("ws://hermes.invalid/messaging");
  clients.push(client);
  void client.start();
  const socket = MemoryWebSocket.instances.at(-1);
  if (!socket) throw new Error("未创建内存 WebSocket");
  socket.open();
  return { client, socket };
}

function route(client: HermesClient, platform = "feishu", chatId = "chat-a", replyTo = "origin-a"): string {
  const agentId = `agent-${nextAgent++}`;
  agentIds.push(agentId);
  (client as unknown as HermesClientInternals).ensureOutboundRouting(platform, chatId, agentId, replyTo);
  return agentId;
}

function publish(agentId: string, type: string, payload: unknown, direction: "inbound" | "outbound" = "inbound"): void {
  eventService.getAcpBus(agentId).publish({ id: crypto.randomUUID(), sessionId: agentId, type, payload, direction });
}

function sent(socket: MemoryWebSocket): Record<string, unknown>[] {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

beforeEach(() => {
  MemoryWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MemoryWebSocket });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const agentId of agentIds.splice(0)) eventService.removeAcpBus(agentId);
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
});

describe("HermesClient 入站回复路由与连接边界", () => {
  // 意图：出站方向的 ACP 事件不属于代理回复，不能转发到外部聊天。
  test("忽略 outbound ACP 事件", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "prompt_complete", {}, "outbound");
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
  });

  // 意图：缺少 payload 的事件不应导致回复处理器抛错。
  test("忽略缺少 payload 的入站事件", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    expect(() => publish(agentId, "session_update", undefined)).not.toThrow();
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
  });

  // 意图：缺少内层 payload 的 session_update 不应产生回复内容。
  test("忽略没有内层 payload 的 session_update", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "session_update", {});
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
  });

  // 意图：非 agent_message_chunk 的会话更新不得被当作文本回复。
  test("忽略其他 sessionUpdate 类型", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "session_update", { payload: { update: { sessionUpdate: "tool_call" } } });
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
  });

  // 意图：非文本 chunk 不能越过协议类型边界写入聊天。
  test("忽略非文本消息块", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "image", text: "x" } } },
    });
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
  });

  // 意图：文本字段不是字符串时不能污染累积回复。
  test("忽略非字符串文本字段", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: 42 } } },
    });
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
  });

  // 意图：有效文本块在完成前只累积，不提前泄漏部分回复。
  test("累积文本块直到 prompt_complete", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一段" } } },
    });
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).at(-1)).toMatchObject({ type: "send", content: "第一段" });
  });

  // 意图：同一回复的多个文本块须按接收顺序拼接。
  test("按顺序拼接多个文本块", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } } },
    });
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "，世界" } } },
    });
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).at(-1)).toMatchObject({ content: "你好，世界" });
  });

  // 意图：完成时带回原始消息 ID，避免回复落到错误会话。
  test("回复转发保留 reply_to", () => {
    const { client, socket } = connectClient();
    const agentId = route(client, "slack", "private-chat", "original-message");
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已收到" } } },
    });
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).at(-1)).toMatchObject({
      platform: "slack",
      chat_id: "private-chat",
      reply_to: "original-message",
    });
  });

  // 意图：完成后必须清空缓存，避免下一轮重复发送旧回复。
  test("prompt_complete 后重置累积文本", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "一次" } } },
    });
    publish(agentId, "prompt_complete", {});
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(1);
  });

  // 意图：同一平台、聊天与代理的重复路由注册只能保留一个订阅。
  test("重复路由注册不重复订阅", () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    (client as unknown as HermesClientInternals).ensureOutboundRouting("feishu", "chat-a", agentId, "origin-a");
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "唯一" } } },
    });
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(1);
  });

  // 意图：不同聊天的路由缓存必须隔离，不能跨会话串回复。
  test("不同聊天使用隔离的回复缓存", () => {
    const { client, socket } = connectClient();
    const firstAgent = route(client, "feishu", "chat-a", "origin-a");
    const secondAgent = route(client, "feishu", "chat-b", "origin-b");
    publish(firstAgent, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A" } } },
    });
    publish(secondAgent, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B" } } },
    });
    publish(secondAgent, "prompt_complete", {});
    publish(firstAgent, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toEqual([
      expect.objectContaining({ chat_id: "chat-b", content: "B", reply_to: "origin-b" }),
      expect.objectContaining({ chat_id: "chat-a", content: "A", reply_to: "origin-a" }),
    ]);
  });

  // 意图：stop 必须注销回复订阅，释放内存并阻止停止后的外部发送。
  test("停止时释放回复路由订阅", async () => {
    const { client, socket } = connectClient();
    const agentId = route(client);
    await client.stop();
    publish(agentId, "session_update", {
      payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "不应发送" } } },
    });
    publish(agentId, "prompt_complete", {});
    expect(sent(socket).filter((message) => message.type === "send")).toHaveLength(0);
  });

  // 意图：心跳触发时发送 ping 帧以维持连接。
  test("心跳周期发送 ping", () => {
    vi.useFakeTimers();
    const { socket } = connectClient();
    vi.advanceTimersByTime(30_000);
    expect(sent(socket)).toContainEqual({ type: "ping" });
  });

  // 意图：未收到 pong 的心跳超时必须关闭失效连接。
  test("pong 超时关闭连接", () => {
    vi.useFakeTimers();
    const { socket } = connectClient();
    vi.advanceTimersByTime(90_000);
    expect(socket.readyState).toBe(3);
  });

  // 意图：收到 pong 应取消当前超时，避免健康连接被错误关闭。
  test("pong 取消当前关闭超时", () => {
    vi.useFakeTimers();
    const { socket } = connectClient();
    vi.advanceTimersByTime(30_000);
    socket.receive('{"type":"pong"}');
    vi.advanceTimersByTime(60_000);
    expect(socket.readyState).toBe(1);
  });

  // 意图：stop 清理心跳计时器，停止后不再发送 ping。
  test("停止后不再发送心跳", async () => {
    vi.useFakeTimers();
    const { client, socket } = connectClient();
    await client.stop();
    vi.advanceTimersByTime(30_000);
    expect(sent(socket).filter((message) => message.type === "ping")).toHaveLength(0);
  });

  // 意图：损坏帧不应阻断同一批次后续合法协议帧的解析。
  test("损坏帧后继续解析后续有效帧", () => {
    const { client, socket } = connectClient();
    socket.receive('{\n{"type":"platform_status","platform":"wecom","state":"connected"}');
    expect(client.getStatus().platforms).toEqual(["wecom"]);
  });

  // 意图：非字符串帧按字符串转换后解析失败时保持连接稳定。
  test("非字符串帧被安全忽略", () => {
    const { client, socket } = connectClient();
    expect(() => socket.receive({ unexpected: true })).not.toThrow();
    expect(client.getStatus().connected).toBeTrue();
  });

  // 意图：WebSocket error 仅记录错误，不应错误改变已连接状态。
  test("WebSocket error 不改变连接状态", () => {
    const { client, socket } = connectClient();
    socket.onerror?.(new Event("error"));
    expect(client.getStatus().connected).toBeTrue();
  });

  // 意图：连接关闭后取消心跳，避免已断开 socket 被定时器再次写入。
  test("连接关闭后停止心跳", () => {
    vi.useFakeTimers();
    const { socket } = connectClient();
    socket.disconnect();
    vi.advanceTimersByTime(30_000);
    expect(sent(socket).filter((message) => message.type === "ping")).toHaveLength(0);
  });
});
