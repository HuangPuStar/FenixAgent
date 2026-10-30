import { afterEach, describe, expect, test } from "bun:test";
import { createDeterministicImRcsSessionId } from "../server/services/langbot/conversation-service";
import { createDataPlaneTestContext, type DataPlaneTestContext, type DataPlaneTestInput } from "./data-plane-fixtures";
import { makeChannel, makeConversation, makeRoute } from "./fixtures";

/**
 * 入站链路回归（规格 §4.3 / §6.1）。
 *
 * 这些用例钉住的是**服务层规则**：去重必须走唯一键、群聊只接受直接 @、路由精确优先于通配、无路由与非
 * 文本都落 skipped 且不进入 Agent。路由层只做协议映射，不在这里重复验证。
 */

const CHANNEL_ID = "0f0e0d0c-0b0a-4a49-8b8a-090807060504";

interface PayloadOptions {
  uuid?: string;
  eventType?: "bot.person_message" | "bot.group_message";
  botUuid?: string;
  senderId?: string;
  groupId?: string;
  components?: unknown[];
}

function makePayload(options: PayloadOptions = {}): Record<string, unknown> {
  const eventType = options.eventType ?? "bot.person_message";
  return {
    uuid: options.uuid ?? crypto.randomUUID(),
    event_type: eventType,
    data: {
      bot_uuid: options.botUuid ?? "bot-1",
      adapter_name: "test",
      sender: { id: options.senderId ?? "user-a", name: "Sender" },
      ...(eventType === "bot.group_message" ? { group: { id: options.groupId ?? "group-1", name: "Group" } } : {}),
      message: options.components ?? [{ type: "Plain", text: "你好" }],
      timestamp: 1_760_000_000,
    },
  };
}

const contexts: DataPlaneTestContext[] = [];

function setup(input: DataPlaneTestInput = {}): DataPlaneTestContext {
  const context = createDataPlaneTestContext({
    channels: [makeChannel({ id: CHANNEL_ID })],
    routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: null, agentConfigId: "agent-1" })],
    ...input,
  });
  contexts.push(context);
  return context;
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispatcher.stop();
});

describe("LangBot 入站", () => {
  // 私聊文本必须落一条 received 事件、建立会话并在同一事务内推进会话活动时间。
  test("私聊文本接受并创建确定性会话", async () => {
    const context = setup();
    const payload = makePayload();

    const outcome = await context.inbound.handle({ channelId: CHANNEL_ID, payload });

    expect(outcome.kind).toBe("accepted");
    expect(context.events.rows).toHaveLength(1);
    const event = context.events.rows[0]!;
    expect(event.status).toBe("received");
    expect(event.text).toBe("你好");
    expect(event.senderId).toBe("user-a");
    expect(context.transactions.count).toBe(1);

    expect(context.conversations.rows).toHaveLength(1);
    const conversation = context.conversations.rows[0]!;
    expect(conversation.chatType).toBe("person");
    expect(conversation.chatId).toBe("user-a");
    expect(conversation.agentConfigId).toBe("agent-1");
    expect(conversation.lastEventAt).toBeInstanceOf(Date);
    expect(conversation.rcsSessionId).toMatch(/^rcs_im_[0-9a-f]{32}$/);
  });

  // 收到并接受事件本身就是链路可用的证据：通道必须从 error 回到 connected，并清掉旧的失败摘要。
  test("入站成功清空通道故障标记", async () => {
    const context = setup({
      channels: [makeChannel({ id: CHANNEL_ID, status: "error", lastError: "实例启动失败" })],
    });

    const outcome = await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });

    expect(outcome.kind).toBe("accepted");
    const channel = context.channels.rows[0]!;
    expect(channel.status).toBe("connected");
    expect(channel.lastError).toBeNull();
  });

  // LangBot 可能因超时重投同一 uuid；第二次必须由唯一键拦下，不能落第二条事件或第二条会话。
  test("同一事件 uuid 重复投递只落一条事件", async () => {
    const context = setup();
    const payload = makePayload();

    const first = await context.inbound.handle({ channelId: CHANNEL_ID, payload });
    const second = await context.inbound.handle({ channelId: CHANNEL_ID, payload });

    expect(first.kind).toBe("accepted");
    expect(second).toEqual({ kind: "duplicate" });
    expect(context.events.rows).toHaveLength(1);
    expect(context.conversations.rows).toHaveLength(1);
  });

  // 群聊只有直接 @ 机器人才进入 Agent；未 @ 是普通旁听，必须拒收且不留下事件行。
  test("群聊未直接 @ 机器人时拒收且不落库", async () => {
    const context = setup({
      routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "group", chatId: null })],
    });

    const outcome = await context.inbound.handle({
      channelId: CHANNEL_ID,
      payload: makePayload({ eventType: "bot.group_message" }),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "not_mentioned" });
    expect(context.events.rows).toHaveLength(0);
    expect(context.transactions.count).toBe(0);
  });

  // AtAll 是 @ 全体，不是对机器人的定向提醒；把它当成直接 @ 会让机器人在每条公告下抢答。
  test("群聊 AtAll 不算直接 @ 机器人", async () => {
    const context = setup({
      routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "group", chatId: null })],
    });

    const outcome = await context.inbound.handle({
      channelId: CHANNEL_ID,
      payload: makePayload({
        eventType: "bot.group_message",
        components: [{ type: "AtAll" }, { type: "Plain", text: "开会了" }],
      }),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "not_mentioned" });
    expect(context.events.rows).toHaveLength(0);
  });

  // 直接 At 的群消息按群 ID 建会话，而不是按发送者：同一个群的所有成员共用一条长会话。
  test("群聊直接 At 后按群 ID 建立会话", async () => {
    const context = setup({
      routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "group", chatId: null, agentConfigId: "agent-g" })],
    });

    const outcome = await context.inbound.handle({
      channelId: CHANNEL_ID,
      payload: makePayload({
        eventType: "bot.group_message",
        groupId: "group-42",
        components: [
          { type: "At", target: "bot-1" },
          { type: "Plain", text: "帮我查一下" },
        ],
      }),
    });

    expect(outcome.kind).toBe("accepted");
    const conversation = context.conversations.rows[0]!;
    expect(conversation.chatType).toBe("group");
    expect(conversation.chatId).toBe("group-42");
    expect(conversation.agentConfigId).toBe("agent-g");
    expect(context.events.rows[0]!.text).toBe("帮我查一下");
  });

  // 没有路由的聊天只记录 skipped：不建会话、不投递、也不回提示（规格 §6.1）。
  test("无路由时标记 skipped 且不创建会话", async () => {
    const context = setup({ routes: [] });

    const outcome = await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "no_route" });
    expect(context.events.rows[0]!.status).toBe("skipped");
    expect(context.conversations.rows).toHaveLength(0);
    expect(context.sent).toHaveLength(0);
  });

  // 通配路由覆盖该类型下所有聊天；同时存在精确路由时必须由精确路由胜出。
  test("通配路由可命中，精确路由优先", async () => {
    const context = setup({
      routes: [
        makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: null, agentConfigId: "agent-wildcard" }),
        makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a", agentConfigId: "agent-exact" }),
      ],
    });

    const outcome = await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });

    expect(outcome.kind).toBe("accepted");
    expect(context.conversations.rows[0]!.agentConfigId).toBe("agent-exact");
    expect(context.events.rows[0]!.agentConfigId).toBe("agent-exact");
  });

  // 图片等非文本事件没有可交给 Agent 的正文：落 skipped 并回固定提示，不建会话。
  test("非文本事件标记 skipped 并发送固定提示", async () => {
    const context = setup({
      routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a" })],
    });

    const outcome = await context.inbound.handle({
      channelId: CHANNEL_ID,
      payload: makePayload({ components: [{ type: "Image", url: "https://example.test/a.png" }] }),
    });

    expect(outcome).toMatchObject({ kind: "skipped", reason: "non_text" });
    expect(context.events.rows[0]!.status).toBe("skipped");
    expect(context.events.rows[0]!.text).toBeNull();
    expect(context.conversations.rows).toHaveLength(0);
    expect(context.notices).toEqual([
      {
        channelId: CHANNEL_ID,
        chatType: "person",
        chatId: "user-a",
        senderId: "user-a",
        text: "当前仅支持文本消息。",
      },
    ]);
  });

  // Webhook 的 bot_uuid 必须与通道凭据一致，否则是投错实例；停用通道同样不接事件。
  test("bot_uuid 不一致与停用通道都拒收", async () => {
    const mismatch = setup();
    expect(
      await mismatch.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload({ botUuid: "other-bot" }) }),
    ).toEqual({ kind: "rejected", reason: "bot_mismatch" });
    expect(mismatch.events.rows).toHaveLength(0);

    const disabled = setup({ channels: [makeChannel({ id: CHANNEL_ID, enabled: false })] });
    expect(await disabled.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() })).toEqual({
      kind: "rejected",
      reason: "channel_disabled",
    });
  });

  // 同一聊天长期复用一条会话；路由改绑 Agent 时必须换确定性会话键并清空旧 ACP session。
  test("会话复用同一 id，换 Agent 重建 rcsSessionId", async () => {
    const context = setup({
      routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a" })],
    });
    await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });

    const conversation = context.conversations.rows[0]!;
    context.conversations.rows[0] = { ...conversation, acpSessionId: "ses_old" };
    const originalRcsSessionId = conversation.rcsSessionId;

    await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });
    expect(context.conversations.rows).toHaveLength(1);
    expect(context.conversations.rows[0]!.id).toBe(conversation.id);
    expect(context.conversations.rows[0]!.rcsSessionId).toBe(originalRcsSessionId);
    expect(context.conversations.rows[0]!.acpSessionId).toBe("ses_old");

    context.routes.rows[0] = { ...context.routes.rows[0]!, agentConfigId: "agent-2" };
    const outcome = await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });

    expect(outcome).toMatchObject({ kind: "accepted", agentChanged: true });
    const updated = context.conversations.rows[0]!;
    expect(updated.id).toBe(conversation.id);
    expect(updated.agentConfigId).toBe("agent-2");
    expect(updated.acpSessionId).toBeNull();
    expect(updated.rcsSessionId).not.toBe(originalRcsSessionId);
  });

  // 会话键只能由 (agentConfigId, ownerUserId, conversationId) 推导：刷新与重启后必须能找回同一份 Y.Doc。
  test("rcsSessionId 对相同输入稳定且不依赖时间", async () => {
    const first = await createDeterministicImRcsSessionId("agent-1", "owner-1", "conversation-1");
    const second = await createDeterministicImRcsSessionId("agent-1", "owner-1", "conversation-1");
    const otherAgent = await createDeterministicImRcsSessionId("agent-2", "owner-1", "conversation-1");

    expect(first).toBe(second);
    expect(first).not.toBe(otherAgent);
    expect(first).toMatch(/^rcs_im_[0-9a-f]{32}$/);
  });
});

// 既有会话行（例如上一进程创建）也必须被复用，而不是每次入站都插入新行。
describe("LangBot 入站会话复用", () => {
  test("已存在的会话行优先于新建", async () => {
    const context = setup({
      routes: [makeRoute({ channelId: CHANNEL_ID, chatType: "person", chatId: "user-a" })],
      conversations: [
        makeConversation({
          id: "conversation-existing",
          channelId: CHANNEL_ID,
          chatType: "person",
          chatId: "user-a",
          agentConfigId: "agent-1",
          rcsSessionId: "rcs_im_0123456789abcdef0123456789abcdef",
          acpSessionId: null,
        }),
      ],
    });

    const outcome = await context.inbound.handle({ channelId: CHANNEL_ID, payload: makePayload() });

    expect(outcome).toMatchObject({ kind: "accepted", conversationId: "conversation-existing" });
    expect(context.conversations.rows).toHaveLength(1);
    expect(context.events.rows[0]!.agentConfigId).toBe("agent-1");
  });
});
