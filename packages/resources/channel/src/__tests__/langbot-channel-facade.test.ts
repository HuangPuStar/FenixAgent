import { afterEach, describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { ChannelControlError } from "../server/contracts";
import { matchRoute } from "../server/services/langbot/route-service";
import {
  createChannelTestContext,
  createRecordingAgentConfigLookup,
  makeChannel,
  makeConversation,
  makeRoute,
  resetChannelModule,
} from "./fixtures";

/**
 * LangBot 控制面门面的行为契约。
 *
 * 这里用真实门面 + 真实服务层 + 内存仓储：跨组织 404、补偿顺序、执行身份与视图脱敏都在这一层，替身门面
 * 只能测到路由转发，测不到这些语义。
 */

function admin(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: "user",
    userId: "admin-1",
    activeOrganizationId: "org-1",
    memberships: [{ organizationId: "org-1", role: "admin" }],
    ...overrides,
  };
}

/** 普通成员：能读组织内资源、能创建通道，但不能改别人的通道。 */
function member(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: "user",
    userId: "member-1",
    activeOrganizationId: "org-1",
    memberships: [{ organizationId: "org-1", role: "member" }],
    ...overrides,
  };
}

afterEach(() => {
  resetChannelModule();
});

describe("LangBot 控制面门面", () => {
  // 跨组织的 Bot 必须按「不存在」处理，且不能为了判断归属去访问 LangBot（替身被调用会直接失败）。
  test("跨组织 Bot 返回 404 且不触发 LangBot", async () => {
    const channel = makeChannel({ organizationId: "org-2", credentials: { botUuid: "bot-other" } });
    const context = createChannelTestContext({ channels: [channel] });

    await expect(context.facade.getBot(admin(), "bot-other")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  // 路由行没有 organization_id，必须经所属通道判定租户；跨组织读不到，也不泄露存在性。
  test("跨组织路由返回 404", async () => {
    const channel = makeChannel({ organizationId: "org-2" });
    const route = makeRoute({ channelId: channel.id });
    const context = createChannelTestContext({ channels: [channel], routes: [route] });

    await expect(context.facade.updateRoute(admin(), route.id, { enabled: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(context.facade.deleteRoute(admin(), route.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // 管理员绑定 Agent 时，端口收到的执行身份必须是通道所有者，不是管理员自己。
  test("创建路由校验通道所有者的 use 权限", async () => {
    const channel = makeChannel({ userId: "owner-9" });
    const recorder = createRecordingAgentConfigLookup();
    const context = createChannelTestContext({ channels: [channel], agentConfigLookup: recorder.lookup });

    await context.facade.createRoute(admin(), {
      channelId: channel.id,
      chatType: "group",
      chatId: "group-1",
      agentConfigId: "agent-1",
    });

    expect(recorder.requests).toEqual([{ organizationId: "org-1", ownerUserId: "owner-9", agentConfigId: "agent-1" }]);
  });

  // 所有者不可用的 Agent 必须拒绝绑定，并给出稳定的 400 业务错误而不是 500。
  test("所有者不可用的 Agent 返回 AGENT_CONFIG_UNAVAILABLE", async () => {
    const channel = makeChannel();
    const recorder = createRecordingAgentConfigLookup({ unavailable: true });
    const context = createChannelTestContext({ channels: [channel], agentConfigLookup: recorder.lookup });

    await expect(
      context.facade.createRoute(admin(), {
        channelId: channel.id,
        chatType: "person",
        chatId: "user-1",
        agentConfigId: "agent-1",
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_UNAVAILABLE", status: 400 });
  });

  // 远端创建成功、本地写入失败时必须补偿删除远端 Bot；错误与日志都不得包含 config。
  test("创建 Bot 本地失败时补偿删除远端且不泄露 config", async () => {
    const sentinel = `secret-${crypto.randomUUID()}`;
    const deleted: string[] = [];
    const context = createChannelTestContext({
      client: {
        createBot: async () => "bot-new",
        deleteBot: async (botUuid) => {
          deleted.push(botUuid);
        },
      },
    });
    context.channels.insert = async () => {
      throw new Error("db down");
    };

    let caught: unknown;
    try {
      await context.facade.createBot(admin(), {
        name: "bot",
        adapter: "telegram",
        config: { token: sentinel },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChannelControlError);
    expect(caught).toMatchObject({ code: "CHANNEL_PERSIST_FAILED" });
    expect((caught as Error).message).not.toContain(sentinel);
    expect(deleted).toEqual(["bot-new"]);
  });

  // 补偿删除也失败时，错误里必须保留可定位的远端 Bot UUID，且仍然不泄露 config。
  test("补偿删除失败时错误保留可定位的 Bot UUID", async () => {
    const sentinel = `secret-${crypto.randomUUID()}`;
    const botUuid = crypto.randomUUID();
    const context = createChannelTestContext({
      client: {
        createBot: async () => botUuid,
        deleteBot: async () => {
          throw new Error("remote down");
        },
      },
    });
    context.channels.insert = async () => {
      throw new Error("db down");
    };

    await expect(
      context.facade.createBot(admin(), { name: "bot", adapter: "telegram", config: { token: sentinel } }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PERSIST_FAILED",
      message: expect.stringContaining(botUuid),
    });
  });

  // 规格 §4.2：删除 Bot 前先清平台侧关联；远端失败时通道行保留并停用，便于人工重试。
  test("删除 Bot 先清关联，远端失败时保留通道并标记停用", async () => {
    const channel = makeChannel();
    const route = makeRoute({ channelId: channel.id });
    const conversation = makeConversation({ channelId: channel.id });
    const context = createChannelTestContext({
      channels: [channel],
      routes: [route],
      conversations: [conversation],
      client: {
        deleteBot: async () => {
          throw new ChannelControlError("LANGBOT_UNREACHABLE", 503, "LangBot 不可达或请求超时");
        },
      },
    });

    await expect(context.facade.deleteBot(admin(), "bot-1")).rejects.toMatchObject({
      code: "LANGBOT_UNREACHABLE",
    });
    expect(context.channels.rows).toHaveLength(1);
    expect(context.routes.rows).toHaveLength(0);
    expect(context.conversations.rows).toHaveLength(0);
    expect(context.channels.rows[0]).toMatchObject({ enabled: false, status: "error" });
    expect(context.channels.rows[0]?.lastError).toContain("LangBot 不可达");
  });

  // Bot 列表是 LangBot 与平台记录的并集：两侧独有条目都要出现，并带上路由绑定数。
  test("Bot 列表合并两侧并标记漂移记录", async () => {
    const boundChannel = makeChannel({ credentials: { botUuid: "bot-1" } });
    const orphanChannel = makeChannel({ name: "已删除的 Bot", credentials: { botUuid: "bot-ghost" } });
    const route = makeRoute({ channelId: boundChannel.id });
    const context = createChannelTestContext({
      channels: [boundChannel, orphanChannel],
      routes: [route],
      client: {
        listBots: async () => [
          { uuid: "bot-1", name: "飞书机器人", adapter: "feishu", createdAt: null, updatedAt: null },
          { uuid: "bot-x", name: "未认领 Bot", adapter: "telegram", createdAt: null, updatedAt: null },
        ],
      },
    });

    const bots = await context.facade.listBots(admin());

    expect(bots.map((bot) => bot.botUuid).sort()).toEqual(["bot-1", "bot-ghost", "bot-x"]);
    const bound = bots.find((bot) => bot.botUuid === "bot-1");
    expect(bound).toMatchObject({ channelId: boundChannel.id, boundRouteCount: 1, missingInLangbot: false });
    expect(bots.find((bot) => bot.botUuid === "bot-ghost")).toMatchObject({ missingInLangbot: true });
    expect(bots.find((bot) => bot.botUuid === "bot-x")).toMatchObject({ channelId: null, missingInLangbot: false });
  });

  // 会话列表只返回脱敏后的会话键，原文与 ACP session 不得进入响应。
  test("会话视图脱敏 sessionId", async () => {
    const channel = makeChannel();
    const conversation = makeConversation({ channelId: channel.id, rcsSessionId: "rcs_secret_value_1234567890" });
    const context = createChannelTestContext({ channels: [channel], conversations: [conversation] });

    const page = await context.facade.listConversations(admin(), { page: 1, pageSize: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sessionId).not.toContain("secret_value");
    expect(page.items[0]?.sessionId).toBe("rcs_…7890");
  });

  // 路由冲突必须在写入前被拒绝（同一通道 + 聊天类型下精确/通配各最多一条）。
  test("重复路由返回 ROUTE_CONFLICT", async () => {
    const channel = makeChannel();
    const context = createChannelTestContext({ channels: [channel] });
    const input = {
      channelId: channel.id,
      chatType: "person" as const,
      chatId: "user-1",
      agentConfigId: "agent-1",
    };

    await context.facade.createRoute(admin(), input);
    await expect(context.facade.createRoute(admin(), input)).rejects.toMatchObject({
      code: "ROUTE_CONFLICT",
      status: 409,
    });
  });

  // 匹配规则：精确优先于通配，停用路由不参与，未命中返回 null。
  test("matchRoute 精确优先、通配回退并过滤停用项", () => {
    const routes = [
      makeRoute({ id: "wild", chatId: null }),
      makeRoute({ id: "exact", chatId: "user-a" }),
      makeRoute({ id: "disabled", chatId: "user-b", enabled: false }),
    ];

    expect(matchRoute(routes, { channelId: "channel-1", chatType: "person", chatId: "user-a" })?.id).toBe("exact");
    expect(matchRoute(routes, { channelId: "channel-1", chatType: "person", chatId: "user-b" })?.id).toBe("wild");
    expect(matchRoute(routes, { channelId: "channel-1", chatType: "person", chatId: "user-z" })?.id).toBe("wild");
    expect(matchRoute(routes, { channelId: "channel-2", chatType: "person", chatId: "user-a" })).toBeNull();
  });

  // 控制面展示的实例必须由入站匹配规则推出：精确路由只认自己的会话，通配只认没被精确认领的，停用路由为空。
  test("路由实例由会话与匹配规则派生", async () => {
    const channel = makeChannel();
    const exact = makeRoute({ channelId: channel.id, chatType: "person", chatId: "user-exact" });
    const wildcard = makeRoute({ channelId: channel.id, chatType: "person", chatId: null });
    const disabled = makeRoute({ channelId: channel.id, chatType: "group", chatId: null, enabled: false });
    const exactConversation = makeConversation({ channelId: channel.id, chatType: "person", chatId: "user-exact" });
    const wildcardConversation = makeConversation({
      channelId: channel.id,
      chatType: "person",
      chatId: "user-wildcard",
    });
    const context = createChannelTestContext({
      channels: [channel],
      routes: [exact, wildcard, disabled],
      conversations: [exactConversation, wildcardConversation],
    });

    const views = await context.facade.listRoutes(admin(), {});
    const instancesOf = (routeId: string) => new Map(views.map((view) => [view.id, view.instances])).get(routeId);

    expect(instancesOf(exact.id)).toEqual([
      { conversationId: exactConversation.id, instanceName: `im-${exactConversation.id}` },
    ]);
    expect(instancesOf(wildcard.id)).toEqual([
      { conversationId: wildcardConversation.id, instanceName: `im-${wildcardConversation.id}` },
    ]);
    expect(instancesOf(disabled.id)).toEqual([]);
  });

  // 普通成员对他人通道的所有变更入口都必须 403，且不能触发任何远端调用或写入。
  test("普通成员修改他人通道返回 403", async () => {
    const channel = makeChannel({ userId: "owner-9" });
    const route = makeRoute({ channelId: channel.id });
    const context = createChannelTestContext({ channels: [channel], routes: [route] });
    const actor = member();

    const forbidden = { code: "FORBIDDEN", status: 403 };
    await expect(context.facade.updateRoute(actor, route.id, { enabled: false })).rejects.toMatchObject(forbidden);
    await expect(context.facade.deleteRoute(actor, route.id)).rejects.toMatchObject(forbidden);
    await expect(
      context.facade.createRoute(actor, {
        channelId: channel.id,
        chatType: "person",
        chatId: "user-1",
        agentConfigId: "agent-1",
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(context.facade.updateBot(actor, "bot-1", { name: "改名" })).rejects.toMatchObject(forbidden);
    await expect(
      context.facade.testSend(actor, "bot-1", { targetType: "person", targetId: "user-1", text: "hi" }),
    ).rejects.toMatchObject(forbidden);
    await expect(context.facade.deleteBot(actor, "bot-1")).rejects.toMatchObject(forbidden);

    expect(context.routes.rows).toHaveLength(1);
    expect(context.routes.rows[0]?.enabled).toBe(true);
    // 管理权限只拦变更：普通成员仍能读取组织内他人通道的路由。
    await expect(context.facade.listRoutes(actor, { channelId: channel.id })).resolves.toHaveLength(1);
  });

  // 创建者即使只是普通成员也拥有自己通道的管理权；创建通道本身对任意成员开放，创建者成为 owner。
  test("普通成员可创建通道并管理自己的通道", async () => {
    const context = createChannelTestContext({
      client: {
        createBot: async () => "bot-new",
        getBot: async () => ({
          uuid: "bot-new",
          name: "我的机器人",
          adapter: "telegram",
          createdAt: null,
          updatedAt: null,
        }),
      },
    });
    const actor = member();

    await context.facade.createBot(actor, { name: "我的机器人", adapter: "telegram", config: {} });
    const created = context.channels.rows[0]!;
    expect(created.userId).toBe("member-1");

    const route = makeRoute({ channelId: created.id });
    context.routes.rows.push(route);

    await expect(context.facade.updateRoute(actor, route.id, { enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
  });

  // 管理员可以改他人通道：管理权限来自当前组织的成员表角色，而不是通道归属。
  test("组织管理员修改他人通道成功", async () => {
    const channel = makeChannel({ userId: "owner-9" });
    const route = makeRoute({ channelId: channel.id });
    const context = createChannelTestContext({ channels: [channel], routes: [route] });

    await expect(context.facade.updateRoute(admin(), route.id, { enabled: false })).resolves.toMatchObject({
      enabled: false,
    });
  });

  // 未提供 active organization 的主体不能操作任何组织资源。
  test("缺少组织上下文时返回 401", async () => {
    const context = createChannelTestContext();

    await expect(
      context.facade.listBots(admin({ activeOrganizationId: undefined, memberships: [] })),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });
});
