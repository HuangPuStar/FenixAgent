// 「组织 → 用户 → 通道 → 实例」拓扑的纯逻辑契约（`/api/system/channels` 的 data.organizations）。
//
// 排序与「只有拥有通道的用户才出现」决定排障者能否一眼定位；按源码读不出边界，集中在本文件钉住。

import { describe, expect, test } from "bun:test";
import { buildChannelTopology } from "../server/services/langbot/channel-topology";
import { makeChannel, makeConversation } from "./fixtures";

const EMPTY_NAMES = new Map<string, string>();
const NO_ADAPTERS = new Map<string, string>();

function at(value: string): Date {
  return new Date(value);
}

describe("通道拓扑组装", () => {
  // 业务意图：组织、用户、通道、实例各自有确定的排序口径，排障时同一份数据每次刷新都要落在同一位置。
  test("按组织名、用户名、通道创建时间排序，实例按最近事件倒序且 null 最后", () => {
    const channels = [
      makeChannel({
        id: "channel-4",
        organizationId: "org-zeta",
        userId: "user-carol",
        name: "zeta 通道",
        createdAt: at("2026-01-01T00:00:00.000Z"),
      }),
      makeChannel({
        id: "channel-2",
        organizationId: "org-alpha",
        userId: "user-bob",
        name: "bob 第二个通道",
        createdAt: at("2026-01-03T00:00:00.000Z"),
      }),
      makeChannel({
        id: "channel-3",
        organizationId: "org-alpha",
        userId: "user-alice",
        name: "alice 通道",
        createdAt: at("2026-01-02T00:00:00.000Z"),
      }),
      makeChannel({
        id: "channel-1",
        organizationId: "org-alpha",
        userId: "user-bob",
        name: "bob 第一个通道",
        createdAt: at("2026-01-01T00:00:00.000Z"),
      }),
    ];
    const conversations = [
      makeConversation({
        id: "conversation-old",
        channelId: "channel-1",
        chatId: "chat-old",
        lastEventAt: at("2026-02-01T00:00:00.000Z"),
      }),
      makeConversation({
        id: "conversation-new",
        channelId: "channel-1",
        chatId: "chat-new",
        lastEventAt: at("2026-03-01T00:00:00.000Z"),
      }),
      makeConversation({ id: "conversation-never", channelId: "channel-1", chatId: "chat-never", lastEventAt: null }),
    ];

    const organizations = buildChannelTopology({
      channels,
      conversations,
      organizationNames: new Map([
        ["org-alpha", "alpha"],
        ["org-zeta", "zeta"],
      ]),
      users: new Map([
        ["user-bob", { name: "bob", email: "bob@example.com" }],
        ["user-alice", { name: "alice", email: "alice@example.com" }],
        ["user-carol", { name: "carol", email: "carol@example.com" }],
      ]),
      adapterByBotUuid: NO_ADAPTERS,
    });

    expect(organizations.map((organization) => organization.name)).toEqual(["alpha", "zeta"]);
    expect(organizations[0]?.users.map((user) => user.name)).toEqual(["alice", "bob"]);
    expect(organizations[0]?.users[1]?.channels.map((channel) => channel.id)).toEqual(["channel-1", "channel-2"]);
    expect(organizations[0]?.users[1]?.channels[0]?.instances.map((instance) => instance.conversationId)).toEqual([
      "conversation-new",
      "conversation-old",
      "conversation-never",
    ]);
  });

  // 业务意图：没有通道的组织/用户在这个页面上没有可操作对象，占位会让排障者误以为通道丢了。
  test("没有通道的组织与没有通道的用户都不出现", () => {
    const organizations = buildChannelTopology({
      channels: [
        makeChannel({ id: "channel-1", organizationId: "org-alpha", userId: "user-with-channel" }),
        makeChannel({ id: "channel-2", organizationId: "org-alpha", userId: "user-with-channel" }),
      ],
      conversations: [],
      organizationNames: new Map([["org-alpha", "alpha"]]),
      users: new Map([
        ["user-with-channel", { name: "owner", email: "owner@example.com" }],
        ["user-without-channel", { name: "ghost", email: "ghost@example.com" }],
      ]),
      adapterByBotUuid: NO_ADAPTERS,
    });

    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.users.map((user) => user.id)).toEqual(["user-with-channel"]);
  });

  // 业务意图：实例名与脱敏会话必须复用宿主创建实例、控制面展示的同一套规则，否则同一会话在两处显示不同标识。
  test("实例名来自 buildImInstanceName，会话键脱敏且渠道适配器来自 Bot 列表", () => {
    const organizations = buildChannelTopology({
      channels: [
        makeChannel({ id: "channel-1", organizationId: "org-1", userId: "user-1", credentials: { botUuid: "bot-1" } }),
      ],
      conversations: [
        makeConversation({ id: "conversation-1", channelId: "channel-1", rcsSessionId: "rcs_0123456789ab" }),
      ],
      organizationNames: EMPTY_NAMES,
      users: new Map([["user-1", { name: "owner", email: "owner@example.com" }]]),
      adapterByBotUuid: new Map([["bot-1", "lark"]]),
    });

    const channel = organizations[0]?.users[0]?.channels[0];
    expect(channel).toMatchObject({ adapter: "lark", botUuid: "bot-1", status: "connected" });
    expect(channel?.instances[0]).toMatchObject({
      instanceName: "im-conversation-1",
      sessionId: "rcs_…89ab",
      chatType: "person",
    });
  });

  // 业务意图：身份目录或缺 Bot 列表时只能降级展示，不能伪造名称，也不能让整棵树失败。
  test("身份目录与 Bot 列表缺失时回退到原始 id 与 null", () => {
    const organizations = buildChannelTopology({
      channels: [makeChannel({ id: "channel-1", organizationId: "org-1", userId: "user-1", credentials: {} })],
      conversations: [],
      organizationNames: EMPTY_NAMES,
      users: new Map(),
      adapterByBotUuid: NO_ADAPTERS,
    });

    const user = organizations[0]?.users[0];
    expect(organizations[0]).toMatchObject({ id: "org-1", name: "org-1" });
    expect(user).toMatchObject({ id: "user-1", name: "user-1", email: null });
    expect(user?.channels[0]).toMatchObject({ adapter: null, botUuid: null, instances: [] });
  });
});
