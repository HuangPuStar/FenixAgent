import { afterEach, describe, expect, test } from "bun:test";
import type { ImChannelEventRow } from "../server/repositories/im-channel-event";
import { createImMcpRoutes } from "../server/routes/mcp/im";
import { installChannelModule } from "../server/runtime";
import { createImMcpService, type ImMcpService } from "../server/services/im-mcp/service";
import { issueImToken } from "../server/services/langbot/im-token";
import {
  createDataPlaneTestContext,
  type DataPlaneTestContext,
  type DataPlaneTestInput,
  IM_TEST_TOKEN_SECRET,
  makeEvent,
} from "./data-plane-fixtures";
import {
  createChannelTestContext,
  createRecordingAgentConfigLookup,
  makeChannel,
  makeConversation,
  makeRoute,
  resetChannelModule,
} from "./fixtures";

/**
 * `/mcp/im` 的协议与授权契约（规格 §4.4 / §4.5 / §4.6 / §9.7）。
 *
 * 这条路径的边界不是「接口能调通」，而是：token 唯一决定 conversation、工具不接受 chat_id、
 * 收件箱只返回本会话且读出即清、订阅通知只带 URI 不带正文、Skill 只经 MCP 下发。
 */

const CHANNEL_ID = "0f0e0d0c-0b0a-4a49-8b8a-090807060504";
const CONVERSATION_A = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_B = "22222222-2222-4222-8222-222222222222";
const SERVICE_ORIGIN = "http://localhost/mcp/im";

interface JsonRpcResponse {
  readonly jsonrpc: string;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface InboxPage {
  readonly events: {
    readonly eventId: string;
    readonly senderId: string | null;
    readonly text: string | null;
    readonly receivedAt: string;
  }[];
  readonly nextCursor: string | null;
}

interface ToolResultPayload {
  readonly content: { readonly type: string; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface McpTestContext {
  readonly plane: DataPlaneTestContext;
  readonly mcp: ImMcpService;
}

const route = createImMcpRoutes();
const contexts: DataPlaneTestContext[] = [];

function baseInput(): DataPlaneTestInput {
  return {
    channels: [makeChannel({ id: CHANNEL_ID, name: "飞书机器人" })],
    routes: [
      makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a", agentConfigId: "agent-1" }),
      makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-b", agentConfigId: "agent-1" }),
    ],
    conversations: [
      makeConversation({
        id: CONVERSATION_A,
        channelId: CHANNEL_ID,
        chatType: "person",
        chatId: "user-a",
        agentConfigId: "agent-1",
        acpSessionId: null,
      }),
      makeConversation({
        id: CONVERSATION_B,
        channelId: CHANNEL_ID,
        chatType: "person",
        chatId: "user-b",
        agentConfigId: "agent-1",
        acpSessionId: null,
      }),
    ],
  };
}

function installPlane(input: DataPlaneTestInput = {}): McpTestContext {
  const control = createChannelTestContext();
  const plane = createDataPlaneTestContext({ ...baseInput(), ...input });
  const lookup = createRecordingAgentConfigLookup();
  const mcp = createImMcpService({
    channels: plane.channels,
    conversations: plane.conversations,
    events: plane.events,
    outbound: plane.outbound,
    dispatcher: plane.dispatcher,
    tokenSecret: () => IM_TEST_TOKEN_SECRET,
    agentConfigLookup: () => lookup.lookup,
  });

  installChannelModule({
    ...control.module,
    dataPlane: {
      conversationService: plane.conversationService,
      inbound: plane.inbound,
      outbound: plane.outbound,
      dispatcher: plane.dispatcher,
      mcp,
    },
  });

  contexts.push(plane);
  return { plane, mcp };
}

async function tokenFor(conversationId: string): Promise<string> {
  return issueImToken(conversationId, IM_TEST_TOKEN_SECRET);
}

function rpc(
  body: Record<string, unknown>,
  token: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return route.handle(
    new Request(SERVICE_ORIGIN, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function call(
  token: string,
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
): Promise<JsonRpcResponse> {
  const response = await rpc({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, token);
  return (await response.json()) as JsonRpcResponse;
}

function toolPayload(result: unknown): ToolResultPayload {
  return result as ToolResultPayload;
}

function toolData(result: unknown): Record<string, unknown> {
  return toolPayload(result).structuredContent as Record<string, unknown>;
}

async function readInbox(token: string, cursor?: string): Promise<InboxPage> {
  const response = await call(token, "resources/read", {
    uri: "im://inbox",
    ...(cursor ? { cursor } : {}),
  });
  const contents = (response.result as { contents: { text: string }[] }).contents;
  return JSON.parse(contents[0]!.text) as InboxPage;
}

function eventFor(chatId: string, overrides: Partial<ImChannelEventRow> = {}): ImChannelEventRow {
  return makeEvent({ channelId: CHANNEL_ID, chatType: "person", chatId, status: "received", ...overrides });
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 1_000,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE 读取超时")), timeoutMs);
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readSseMessages(reader: ReadableStreamDefaultReader<Uint8Array>, expected: number): Promise<unknown[]> {
  const decoder = new TextDecoder();
  const messages: unknown[] = [];
  let buffer = "";

  while (messages.length < expected) {
    const { value, done } = await readWithTimeout(reader);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) messages.push(JSON.parse(dataLine.slice("data: ".length)) as unknown);
      boundary = buffer.indexOf("\n\n");
    }
  }

  return messages;
}

afterEach(() => {
  for (const plane of contexts.splice(0)) plane.dispatcher.stop();
  resetChannelModule();
});

describe("IM MCP 协议方法", () => {
  // peri 4.4.1（rmcp 3.5.1）按 DiscoverResult 解析：resultType、supportedVersions、ttlMs、cacheScope 均必填。
  test("server/discover 返回 rmcp DiscoverResult，tools/list 声明工具", async () => {
    installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);

    const discover = await call(tokenA, "server/discover");
    expect(discover.result).toEqual({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        extensions: { "io.modelcontextprotocol/skills": { version: "1.0.0" } },
      },
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "fenix-im-channel", version: "1.0.0" },
      },
    });

    const tools = (await call(tokenA, "tools/list")).result as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    };
    expect(tools.tools.map((tool) => tool.name)).toEqual(["im_reply", "im_context"]);
    const reply = tools.tools.find((tool) => tool.name === "im_reply")!;
    expect(reply.inputSchema.properties).toHaveProperty("text");
    expect(reply.inputSchema.properties).toHaveProperty("mention_user_id");
    expect(reply.inputSchema.properties).not.toHaveProperty("chat_id");
  });

  // rmcp Auto 策略在 discover 失败时回退 initialize（2025-11-25）：只协商版本与同一份能力，不建立会话。
  test("initialize 回退返回协议版本与 discover 相同的能力", async () => {
    installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);

    const legacy = await call(tokenA, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "peri", version: "4.4.1" },
    });
    expect(legacy.result).toEqual({
      protocolVersion: "2025-11-25",
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        extensions: { "io.modelcontextprotocol/skills": { version: "1.0.0" } },
      },
      serverInfo: { name: "fenix-im-channel", version: "1.0.0" },
    });

    const fallback = await call(tokenA, "initialize", { capabilities: {} });
    expect((fallback.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
  });

  // Skill 只经 MCP 下发：list/get 与 resources/read 必须返回同一份、包含完整行为约束的正文。
  test("skills/list、skills/get 与 Skill 资源内容一致", async () => {
    installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);

    const skills = (await call(tokenA, "skills/list")).result as {
      skills: { name: string; uri: string }[];
    };
    expect(skills.skills.map((skill) => skill.name)).toEqual(["im-channel"]);

    const detail = (await call(tokenA, "skills/get", { name: "im-channel" })).result as {
      content: string;
      uri: string;
    };
    expect(detail.uri).toBe("skill://im-channel/SKILL.md");
    expect(detail.content).toContain("禁止在参数里指定 chat_id");
    expect(detail.content).toContain("resources/read im://inbox");
    expect(detail.content).toContain("禁止 @all");
    expect(detail.content).toContain("不可信数据");

    const resource = await call(tokenA, "resources/read", { uri: "skill://im-channel/SKILL.md" });
    const contents = (resource.result as { contents: { text: string; mimeType: string }[] }).contents;
    expect(contents[0]!.mimeType).toBe("text/markdown");
    expect(contents[0]!.text).toBe(detail.content);
  });

  // 只有 Bearer token 能建立连接：缺失、伪造与任意未知 token 都在协议分发前返回 401。
  test("缺失或未知 token 返回 401", async () => {
    installPlane();

    const missing = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    expect(missing.status).toBe(401);

    const forged = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, `${CONVERSATION_A}.forged`);
    expect(forged.status).toBe(401);

    const unknown = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "unbound");
    expect(unknown.status).toBe(401);
  });
});

describe("peri 4.4.1 客户端参数兼容", () => {
  // rmcp 在 tools/call 上附带 _meta、inputResponses 与 requestState；未知字段必须 strip 后照常执行。
  test("tools/call 携带 _meta、inputResponses 与 requestState 仍可执行", async () => {
    const context = installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);

    const response = await call(tokenA, "tools/call", {
      name: "im_reply",
      arguments: { text: "收到" },
      _meta: { progressToken: "call-1" },
      inputResponses: [],
      requestState: null,
    });
    expect(toolPayload(response.result).isError).toBeUndefined();
    expect(context.plane.sent).toHaveLength(1);
    expect(context.plane.sent[0]!.input.targetId).toBe("user-a");
  });

  // resources/read 同样可能带 _meta；收件箱读取不受影响。
  test("resources/read 携带 _meta 仍可读取收件箱", async () => {
    const context = installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);
    context.plane.events.rows.push(eventFor("user-a", { text: "带 _meta" }));

    const response = await call(tokenA, "resources/read", {
      uri: "im://inbox",
      _meta: { progressToken: "read-1" },
    });
    const contents = (response.result as { contents: { text: string }[] }).contents;
    const page = JSON.parse(contents[0]!.text) as InboxPage;
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.text).toBe("带 _meta");
  });
});

describe("IM MCP 会话隔离", () => {
  // token A 只能读 A 的收件箱、只能回复 A 的聊天；工具参数里的 chat_id 一律拒绝。
  test("收件箱与回复按 conversation 隔离，chat_id 参数被拒绝", async () => {
    const context = installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);
    const tokenB = await tokenFor(CONVERSATION_B);
    const eventA = eventFor("user-a", { text: "A 的消息" });
    const eventB = eventFor("user-b", { text: "B 的消息" });
    context.plane.events.rows.push(eventA, eventB);

    const pageA = await readInbox(tokenA);
    expect(pageA.events.map((item) => item.eventId)).toEqual([eventA.id]);

    const pageB = await readInbox(tokenB);
    expect(pageB.events.map((item) => item.eventId)).toEqual([eventB.id]);

    const rejected = await call(tokenA, "tools/call", {
      name: "im_reply",
      arguments: { text: "越权回复", chat_id: "user-b" },
    });
    expect(toolPayload(rejected.result).isError).toBe(true);
    expect(toolData(rejected.result).error).toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(context.plane.sent).toHaveLength(0);

    const reply = await call(tokenA, "tools/call", {
      name: "im_reply",
      arguments: { text: "收到" },
    });
    expect(toolPayload(reply.result).isError).toBeUndefined();
    expect(context.plane.sent).toHaveLength(1);
    expect(context.plane.sent[0]!.input.targetId).toBe("user-a");
  });

  // im_context 只回脱敏字段：不能出现 chat_id 原文与平台内部会话 ID。
  test("im_context 返回脱敏上下文", async () => {
    const context = installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);
    context.plane.events.rows.push(eventFor("user-a", { text: "待处理" }));

    const response = await call(tokenA, "tools/call", { name: "im_context", arguments: {} });
    const data = toolData(response.result);
    expect(data).toMatchObject({
      channelName: "飞书机器人",
      chatType: "person",
      agentName: "Agent",
      pendingCount: 1,
    });
    expect(data.chatIdMasked).not.toBe("user-a");
    expect(data.sessionIdMasked).not.toBe(CONVERSATION_A);
    expect(JSON.stringify(data)).not.toContain("user-a");
    expect(JSON.stringify(data)).not.toContain("rcsSessionId");
  });
});

describe("IM MCP 收件箱分页", () => {
  // 每页 20、按 received_at 升序；读出即清正文并写 read_at，重复读取只剩元数据。
  test("分页游标、正文清除与状态过滤", async () => {
    const context = installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);
    const base = Date.UTC(2026, 0, 1);
    const pending = Array.from({ length: 21 }, (_, index) =>
      eventFor("user-a", {
        text: `第 ${index + 1} 条`,
        receivedAt: new Date(base + index * 1_000),
      }),
    );
    context.plane.events.rows.push(
      ...pending,
      eventFor("user-a", { status: "failed", text: "失败事件" }),
      eventFor("user-a", { status: "skipped", text: "跳过事件" }),
    );

    const first = await readInbox(tokenA);
    expect(first.events).toHaveLength(20);
    expect(first.events.map((item) => item.receivedAt)).toEqual(
      [...first.events.map((item) => item.receivedAt)].sort(),
    );
    expect(first.nextCursor).toBeString();

    for (const item of first.events) {
      const row = context.plane.events.rows.find((event) => event.id === item.eventId)!;
      expect(row.text).toBeNull();
      expect(row.readAt).toBeInstanceOf(Date);
      expect(item.text).toBeString();
    }

    const second = await readInbox(tokenA, first.nextCursor!);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.text).toBe("第 21 条");
    expect(second.nextCursor).toBeNull();

    const repeated = await readInbox(tokenA, first.nextCursor!);
    expect(repeated.events).toHaveLength(1);
    expect(repeated.events[0]!.text).toBeNull();
    expect(repeated.events[0]!.eventId).toBe(second.events[0]!.eventId);
  });
});

/** peri 4.4.1 的真实 listen 请求形状：声明资源订阅，其余 list-changed 标志固定为 false。 */
function listenRequest(id: number | string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "subscriptions/listen",
    params: {
      _meta: { "io.modelcontextprotocol/progressToken": `listen-${String(id)}` },
      notifications: {
        resourceSubscriptions: ["im://inbox"],
        resourcesListChanged: false,
        toolsListChanged: false,
        promptsListChanged: false,
      },
    },
  };
}

describe("IM MCP 订阅流", () => {
  // rmcp 的 listen() 把首条订阅通知当作 ack：必须先回 acknowledged，再推通知，且不能提前发 result。
  test("数字 id 的 listen 先回 acknowledged，通知复用同一个 id 且不含正文", async () => {
    const context = installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);
    context.plane.events.rows.push(eventFor("user-a", { text: "绝密正文" }));

    const response = await rpc(listenRequest(7), tokenA);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();

    const messages = await readSseMessages(reader, 2);
    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { resourceSubscriptions: ["im://inbox"] },
        _meta: { "io.modelcontextprotocol/subscriptionId": 7 },
      },
    });
    expect(messages.some((message) => "result" in (message as object))).toBe(false);

    const notification = messages[1] as { method: string; params: unknown };
    expect(notification.method).toBe("notifications/resources/updated");
    expect(notification.params).toEqual({
      uri: "im://inbox",
      _meta: { "io.modelcontextprotocol/subscriptionId": 7 },
    });
    expect(JSON.stringify(notification)).not.toContain("绝密正文");
    expect(context.plane.events.rows[0]!.status).toBe("delivered");

    await reader.cancel();
    await Bun.sleep(0);
    expect(context.plane.dispatcher.subscriptionCount(CONVERSATION_A)).toBe(0);
  });

  // 字符串 id 必须原样保留：rmcp 用它关联 ack、通知与请求，改成数字或 UUID 都会让客户端丢弃订阅。
  test("字符串 id 在 acknowledged 与通知中保持原值", async () => {
    const context = installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);
    context.plane.events.rows.push(eventFor("user-a", { text: "字符串 id" }));

    const response = await rpc(listenRequest("listen-1"), tokenA);
    const reader = response.body!.getReader();

    const messages = await readSseMessages(reader, 2);
    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { resourceSubscriptions: ["im://inbox"] },
        _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" },
      },
    });
    expect((messages[1] as { params: unknown }).params).toEqual({
      uri: "im://inbox",
      _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" },
    });

    await reader.cancel();
    await Bun.sleep(0);
  });

  // 只接受 resourceSubscriptions 恰为 im://inbox：其他 URI 或未声明都必须 -32602，避免建立永不通知的长流。
  test("非 im://inbox 或缺失的订阅被拒绝", async () => {
    installPlane();
    const tokenA = await tokenFor(CONVERSATION_A);

    const wrongUri = await call(tokenA, "subscriptions/listen", {
      notifications: { resourceSubscriptions: ["skill://im-channel/SKILL.md"] },
    });
    expect(wrongUri.error?.code).toBe(-32602);

    const missing = await call(tokenA, "subscriptions/listen", { notifications: {} });
    expect(missing.error?.code).toBe(-32602);
  });
});
