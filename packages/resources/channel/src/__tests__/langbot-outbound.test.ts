import { afterEach, describe, expect, test } from "bun:test";
import { ChannelControlError } from "../server/contracts";
import { createLangBotClient } from "../server/services/langbot/client";
import { ImTokenError, issueImToken, verifyImToken } from "../server/services/langbot/im-token";
import { splitImReplyText } from "../server/services/langbot/outbound-service";
import {
  createDataPlaneTestContext,
  type DataPlaneTestContext,
  type DataPlaneTestInput,
  IM_TEST_TOKEN_SECRET,
  makeEvent,
} from "./data-plane-fixtures";
import { makeChannel, makeConversation, makeRoute } from "./fixtures";

/**
 * 连接 token 与出站回复回归（规格 §4.4 / §6.2 / §9）。
 *
 * 重点不是「消息发出去了」，而是三条授权边界：token 只能绑定一个会话、群聊只能 @ 会话内近期出现的人、
 * 分片不能重复提醒或切断代理对。
 */

const CHANNEL_ID = "0f0e0d0c-0b0a-4a49-8b8a-090807060504";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-06-01T00:00:00.000Z");

const contexts: DataPlaneTestContext[] = [];

function setup(input: DataPlaneTestInput = {}): DataPlaneTestContext {
  const context = createDataPlaneTestContext({
    channels: [makeChannel({ id: CHANNEL_ID })],
    ...input,
  });
  contexts.push(context);
  return context;
}

function setupPerson(input: DataPlaneTestInput = {}): DataPlaneTestContext {
  return setup({
    now: () => NOW,
    conversations: [
      makeConversation({
        id: CONVERSATION_ID,
        channelId: CHANNEL_ID,
        chatType: "person",
        chatId: "user-a",
        agentConfigId: "agent-1",
        acpSessionId: null,
      }),
    ],
    routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a", agentConfigId: "agent-1" })],
    ...input,
  });
}

/** 记录调用次数并按次序作答的假 fetch；走真实客户端才能覆盖错误映射与重试判定。 */
function createSequencedFetch(handler: (call: number) => Response | Promise<Response>): {
  readonly fetcher: typeof fetch;
  readonly calls: () => number;
} {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return handler(calls);
  };
  return { fetcher, calls: () => calls };
}

/** 用真实客户端替换出站发送：错误映射与 `retryable` 都由生产代码产生。 */
function realSendMessage(fetcher: typeof fetch) {
  const client = createLangBotClient({
    baseUrl: "http://langbot.test/api/v1",
    apiKey: "test-api-key",
    fetcher,
  });
  return client.sendMessage;
}

function sentOk(): Response {
  return Response.json({ code: 0, data: { sent: true } });
}

function upstreamStatus(status: number): Response {
  return new Response("{}", { status, headers: { "content-type": "application/json" } });
}

function setupGroup(events: ReturnType<typeof makeEvent>[] = []): DataPlaneTestContext {
  return setup({
    now: () => NOW,
    conversations: [
      makeConversation({
        id: CONVERSATION_ID,
        channelId: CHANNEL_ID,
        chatType: "group",
        chatId: "group-1",
        agentConfigId: "agent-1",
        acpSessionId: null,
      }),
    ],
    routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "group", chatId: "group-1", agentConfigId: "agent-1" })],
    events,
  });
}

function groupRecentEvents(): ReturnType<typeof makeEvent>[] {
  return [
    makeEvent({
      channelId: CHANNEL_ID,
      chatType: "group",
      chatId: "group-1",
      senderId: "user-new",
      receivedAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
    }),
    makeEvent({
      channelId: CHANNEL_ID,
      chatType: "group",
      chatId: "group-1",
      senderId: "user-old",
      receivedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000),
    }),
  ];
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispatcher.stop();
});

describe("IM 连接 token", () => {
  // token 的作用域就是 conversation：换一个 id 保留签名必须失败。
  test("签发的 token 只校验回原会话", async () => {
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);
    expect(token.startsWith(`im_${CONVERSATION_ID}.`)).toBe(true);
    expect(await verifyImToken(token, IM_TEST_TOKEN_SECRET)).toBe(CONVERSATION_ID);

    const signature = token.slice(token.indexOf(".") + 1);
    const forged = `im_${crypto.randomUUID()}.${signature}`;
    expect(await verifyImToken(forged, IM_TEST_TOKEN_SECRET)).toBeNull();
    expect(await verifyImToken(token, "other-secret")).toBeNull();
  });

  // 密钥缺失或会话 id 非法时签发必须失败，不能降级成无签名 token。
  test("缺少密钥或会话 id 非法时拒绝签发", async () => {
    await expect(issueImToken(CONVERSATION_ID, undefined)).rejects.toBeInstanceOf(ImTokenError);
    await expect(issueImToken("not-a-uuid", IM_TEST_TOKEN_SECRET)).rejects.toBeInstanceOf(ImTokenError);
    expect(await verifyImToken(`im_${CONVERSATION_ID}.sig`, undefined)).toBeNull();
  });
});

describe("IM 出站回复", () => {
  // 私聊回复不带 At：只有群聊才需要提醒触发者。
  test("私聊回复按会话的目标发送", async () => {
    const context = setupPerson();
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "收到" });

    expect(result).toEqual({ ok: true });
    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]!.input).toMatchObject({
      targetType: "person",
      targetId: "user-a",
      text: "收到",
      mentionUserId: null,
    });
  });

  // 群聊未显式指定 @ 时回退到最近一条事件的发送者；这是唯一的「当前触发者」来源。
  test("群聊未指定时 @ 最近事件的发送者", async () => {
    const context = setupGroup(groupRecentEvents());
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "处理好了" });

    expect(result).toEqual({ ok: true });
    expect(context.sent[0]!.input.mentionUserId).toBe("user-new");
  });

  // @all 一类保留词与任何以 @ 开头的伪 ID 都必须拒绝，不能交给 LangBot 解释。
  test("群聊拒绝 @ 全体成员", async () => {
    const context = setupGroup(groupRecentEvents());
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    for (const mentionUserId of ["all", "everyone", "here", "@all"]) {
      const result = await context.outbound.reply({ token, text: "公告", mentionUserId });
      expect(result).toMatchObject({ ok: false, error: { code: "MENTION_NOT_ALLOWED" } });
    }
    expect(context.sent).toHaveLength(0);
  });

  // 只能 @ 该会话近期出现过的人：任意 ID 会让 Agent 打扰会话外成员。
  test("群聊拒绝 @ 会话外成员，接受近期成员", async () => {
    const context = setupGroup(groupRecentEvents());
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const outside = await context.outbound.reply({ token, text: "在吗", mentionUserId: "user-x" });
    expect(outside).toMatchObject({ ok: false, error: { code: "MENTION_NOT_ALLOWED" } });
    expect(context.sent).toHaveLength(0);

    const inside = await context.outbound.reply({ token, text: "在吗", mentionUserId: "user-old" });
    expect(inside).toEqual({ ok: true });
    expect(context.sent[0]!.input.mentionUserId).toBe("user-old");
  });

  // 4000 字符分片；@ 只拼在第一片，否则每片都会重复提醒。
  test("长回复按 4000 字符分片，@ 只出现在首片", async () => {
    const context = setupGroup(groupRecentEvents());
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);
    const text = "a".repeat(4_500);

    const result = await context.outbound.reply({ token, text, mentionUserId: "user-new" });

    expect(result).toEqual({ ok: true });
    expect(context.sent).toHaveLength(2);
    expect(context.sent[0]!.input.text).toHaveLength(4_000);
    expect(context.sent[1]!.input.text).toHaveLength(500);
    expect(context.sent[0]!.input.mentionUserId).toBe("user-new");
    expect(context.sent[1]!.input.mentionUserId).toBeNull();
  });

  // 无界切片会把模型的一次输出放大成发送循环；超过 20 片直接失败且不发任何一片。
  test("超过 20 片的回复拒绝发送", async () => {
    const context = setupPerson();
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "a".repeat(4_000 * 20 + 1) });

    expect(result).toMatchObject({ ok: false, error: { code: "SEND_FAILED" } });
    expect(context.sent).toHaveLength(0);
  });

  // 5 秒内的相同回复是模型重试或网络重放，直接返回上次成功结果，不重复发送。
  test("5 秒内相同文本只发送一次", async () => {
    const context = setupPerson();
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const first = await context.outbound.reply({ token, text: "重复" });
    const second = await context.outbound.reply({ token, text: "重复" });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(context.sent).toHaveLength(1);
  });

  // 无效 token、停用通道与路由改绑都是可预期拒绝，不能把消息发到旧 Agent 或旧会话。
  test("无效 token、停用通道与 Agent 改绑都拒绝发送", async () => {
    const invalid = setupPerson();
    expect(await invalid.outbound.reply({ token: "im_not-a-uuid.sig", text: "x" })).toMatchObject({
      ok: false,
      error: { code: "TOKEN_INVALID" },
    });

    const disabled = setup({
      channels: [makeChannel({ id: CHANNEL_ID, enabled: false })],
      conversations: [makeConversation({ id: CONVERSATION_ID, channelId: CHANNEL_ID, acpSessionId: null })],
      routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a" })],
    });
    const disabledToken = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);
    expect(await disabled.outbound.reply({ token: disabledToken, text: "x" })).toMatchObject({
      ok: false,
      error: { code: "SEND_FAILED" },
    });

    const rebound = setupPerson();
    rebound.routes.rows[0] = { ...rebound.routes.rows[0]!, agentConfigId: "agent-2" };
    const reboundToken = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);
    expect(await rebound.outbound.reply({ token: reboundToken, text: "x" })).toMatchObject({
      ok: false,
      error: { code: "SEND_FAILED" },
    });
  });

  // LangBot 不可达必须与普通发送失败区分，便于 MCP 层提示重连而不是重试。
  test("LangBot 不可达返回 LANGBOT_UNREACHABLE", async () => {
    const context = setupPerson();
    context.client.sendMessage = async () => {
      throw new ChannelControlError("LANGBOT_UNREACHABLE", 503, "unreachable");
    };
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "x" });

    expect(result).toMatchObject({ ok: false, error: { code: "LANGBOT_UNREACHABLE" } });
  });

  // 上游 400 是确定性拒绝：真实客户端把它标为不可重试，必须只调用一次。
  test("上游 400 不重试", async () => {
    const fetch = createSequencedFetch(() => upstreamStatus(400));
    const context = setupPerson({ sendMessage: realSendMessage(fetch.fetcher) });
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "x" });

    expect(result).toMatchObject({ ok: false, error: { code: "SEND_FAILED" } });
    expect(fetch.calls()).toBe(1);
  });

  // 429 是上游限流，属于瞬时状态：重试一次后成功。
  test("上游 429 重试一次后成功", async () => {
    const fetch = createSequencedFetch((call) => (call === 1 ? upstreamStatus(429) : sentOk()));
    const context = setupPerson({ sendMessage: realSendMessage(fetch.fetcher) });
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "x" });

    expect(result).toEqual({ ok: true });
    expect(fetch.calls()).toBe(2);
  });

  // 两次 5xx 后放弃：重试次数有上限，不能把一次工具调用变成无界发送循环。
  test("连续两次 5xx 返回 SEND_FAILED", async () => {
    const fetch = createSequencedFetch(() => upstreamStatus(500));
    const context = setupPerson({ sendMessage: realSendMessage(fetch.fetcher) });
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "x" });

    expect(result).toMatchObject({ ok: false, error: { code: "SEND_FAILED" } });
    expect(fetch.calls()).toBe(2);
  });

  // 网络失败/超时没有上游状态可读，同样只重试一次。
  test("网络错误重试一次", async () => {
    const fetch = createSequencedFetch(() => {
      throw new TypeError("network down");
    });
    const context = setupPerson({ sendMessage: realSendMessage(fetch.fetcher) });
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "x" });

    expect(result).toMatchObject({ ok: false, error: { code: "LANGBOT_UNREACHABLE" } });
    expect(fetch.calls()).toBe(2);
  });

  // HTTP 200 但业务 code != 0 是业务拒绝：不能按「5xx 重试」误判，必须只调用一次。
  test("HTTP 200 业务失败不重试", async () => {
    const fetch = createSequencedFetch(() => Response.json({ code: 1, msg: "rejected" }));
    const context = setupPerson({ sendMessage: realSendMessage(fetch.fetcher) });
    const token = await issueImToken(CONVERSATION_ID, IM_TEST_TOKEN_SECRET);

    const result = await context.outbound.reply({ token, text: "x" });

    expect(result).toMatchObject({ ok: false, error: { code: "SEND_FAILED" } });
    expect(fetch.calls()).toBe(1);
  });
});

describe("回复切片", () => {
  // 按码点切片，不能把 emoji 的代理对从中间切开。
  test("分片不会切断代理对", () => {
    const chunks = splitImReplyText("😀😀😀", 2);
    expect(chunks).toEqual(["😀😀", "😀"]);
    expect(Array.from(chunks[0]!)).toHaveLength(2);
  });
});

describe("LangBot Bot 写入契约", () => {
  /** 记录上游收到的请求，用来断言字段名而不只是「调用成功」。 */
  function createRecordingFetch(responses: Response[]) {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      return responses[requests.length - 1] ?? Response.json({ code: 0, data: null });
    };
    return { fetcher, requests };
  }

  // 业务意图：上游字段名是 adapter_config；发成 config 会被它的 BOT_FIELDS 白名单丢弃并报 500。
  // 创建后必须再 PUT 一次 enable：上游 create 只加载不启动，适配器不会连接 IM。
  test("创建时启用 Bot，更新时合并现有配置", async () => {
    const fetch = createRecordingFetch([
      Response.json({ code: 0, data: { uuid: "bot-1" } }),
      Response.json({ code: 0, data: null }),
      Response.json({
        code: 0,
        data: { bot: { adapter_config: { token: "old-token", markdown_card: true } } },
      }),
      Response.json({ code: 0, data: null }),
    ]);
    const client = createLangBotClient({
      baseUrl: "http://langbot.test/api/v1",
      apiKey: "test-api-key",
      fetcher: fetch.fetcher,
    });

    const botUuid = await client.createBot({
      name: "测试",
      adapter: "telegram-omni",
      config: { token: "secret-token" },
    });
    await client.updateBot(botUuid, { name: "测试二", config: { token: "next-token" } });

    expect(fetch.requests.map((request) => request.method)).toEqual(["POST", "PUT", "GET", "PUT"]);
    expect(fetch.requests[0]!.url).toBe("http://langbot.test/api/v1/platform/bots");
    expect(JSON.parse(fetch.requests[0]!.body ?? "{}")).toEqual({
      name: "测试",
      adapter: "telegram-omni",
      adapter_config: { token: "secret-token" },
      enable: true,
    });
    expect(JSON.parse(fetch.requests[1]!.body ?? "{}")).toEqual({ enable: true });
    expect(JSON.parse(fetch.requests[3]!.body ?? "{}")).toEqual({
      name: "测试二",
      // PUT 整体替换 adapter_config：未填写的 markdown_card 必须从远端读回后保留。
      adapter_config: { token: "next-token", markdown_card: true },
    });
  });

  // 业务意图：创建后启动失败时远端已留下 Bot 行，必须补偿删除，避免平台重试产生同名孤儿。
  test("创建后启动失败会删除远端 Bot", async () => {
    const fetch = createRecordingFetch([
      Response.json({ code: 0, data: { uuid: "bot-2" } }),
      Response.json({ code: -1, msg: "bot apply failed" }, { status: 500 }),
      Response.json({ code: 0, data: null }),
    ]);
    const client = createLangBotClient({
      baseUrl: "http://langbot.test/api/v1",
      apiKey: "test-api-key",
      fetcher: fetch.fetcher,
    });

    await expect(
      client.createBot({ name: "坏配置", adapter: "telegram-omni", config: { token: "x" } }),
    ).rejects.toThrow();
    expect(fetch.requests.map((request) => request.method)).toEqual(["POST", "PUT", "DELETE"]);
  });
});
