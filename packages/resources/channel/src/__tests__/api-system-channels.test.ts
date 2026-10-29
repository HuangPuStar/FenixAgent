// `/api/system/channels` 的协议契约：系统 key 守卫、跨组织拓扑、上游故障降级与空数据形状。
//
// 守卫是注入的替身（见 `guard-stubs.ts`）：它按固定 key 拒绝缺凭据的请求，因此「路由漏声明
// `systemApiKeyAuth`」会直接表现为 200，而不是一个看不出来的覆盖缺口。

import { afterEach, describe, expect, test } from "bun:test";
import { resetIdentityDirectoryStub, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { createChannelSystemApiRoutes } from "../server/routes/api/system-channels";
import { createChannelTestContext, makeChannel, makeConversation, resetChannelModule } from "./fixtures";
import { createStubSystemApiGuardPlugin, TEST_SYSTEM_API_KEY } from "./guard-stubs";

const route = createChannelSystemApiRoutes({ systemApiGuardPlugin: createStubSystemApiGuardPlugin() });

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

/** 带系统 key 的请求；缺省路径就是页面实际调用的那一条。 */
function authorized(path = "/api/system/channels") {
  return request(path, { headers: { authorization: `Bearer ${TEST_SYSTEM_API_KEY}` } });
}

const SYSTEM_KEY_HEADERS = { "content-type": "application/json" };

afterEach(() => {
  resetChannelModule();
  resetIdentityDirectoryStub();
});

describe("系统通道拓扑接口", () => {
  // 业务意图：admin 页面一次取全量数据——连通性 + 组织/用户/通道/实例四层，缺一层就要多发一轮请求。
  test("带系统 key 时返回跨组织拓扑与脱敏会话", async () => {
    stubIdentityDirectory({
      listOrganizationNames: async () => new Map([["org-1", "研发部"]]),
      listUserDisplayInfo: async () => new Map([["user-1", { id: "user-1", name: "张三", email: "zs@example.com" }]]),
    });
    createChannelTestContext({
      channels: [
        makeChannel({
          id: "channel-1",
          organizationId: "org-1",
          userId: "user-1",
          name: "飞书机器人",
          credentials: { botUuid: "bot-1" },
        }),
      ],
      conversations: [
        makeConversation({ id: "conversation-1", channelId: "channel-1", rcsSessionId: "rcs_0123456789ab" }),
      ],
      client: {
        status: async () => ({ reachable: true, version: "v4.11.2", edition: "ce", wizardStatus: "done" }),
        listBots: async () => [
          { uuid: "bot-1", name: "飞书机器人", adapter: "lark", createdAt: null, updatedAt: null },
        ],
      },
    });

    const response = await authorized();
    const body = (await response.json()) as {
      success: boolean;
      data: {
        status: Record<string, unknown>;
        organizations: {
          id: string;
          name: string;
          users: { name: string; email: string | null; channels: { adapter: string | null; instances: unknown[] }[] }[];
        }[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toEqual({
      reachable: true,
      version: "v4.11.2",
      edition: "ce",
      wizardStatus: "done",
    });
    expect(body.data.organizations).toHaveLength(1);
    expect(body.data.organizations[0]).toMatchObject({ id: "org-1", name: "研发部" });
    expect(body.data.organizations[0]?.users[0]).toMatchObject({ name: "张三", email: "zs@example.com" });
    expect(body.data.organizations[0]?.users[0]?.channels[0]).toMatchObject({ adapter: "lark" });
    expect(body.data.organizations[0]?.users[0]?.channels[0]?.instances).toHaveLength(1);
    // 会话键只以脱敏形式出现。
    expect(JSON.stringify(body)).not.toContain("rcs_0123456789ab");
  });

  // 业务意图：系统面是最高权限入口，没有 key 时必须被守卫挡住，且不返回任何组织数据。
  test("没有系统 key 时返回 401 且不返回任何通道数据", async () => {
    createChannelTestContext({ channels: [makeChannel({ id: "channel-1" })] });

    const response = await request("/api/system/channels", { headers: SYSTEM_KEY_HEADERS });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(JSON.stringify(body)).not.toContain("channel-1");
  });

  // 业务意图：没有任何通道时页面显示空态；空组织不得以占位形式出现在响应里。
  test("没有通道时 organizations 为空数组", async () => {
    createChannelTestContext({ channels: [] });

    const response = await authorized();
    const body = (await response.json()) as { success: boolean; data: { organizations: unknown[] } };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { status: { reachable: false, version: null, edition: null, wizardStatus: null }, organizations: [] },
    });
  });

  // 业务意图：排障页最需要它的时刻就是上游坏掉的时候——LangBot 故障只能让状态卡变红，不能让整页 500。
  test("LangBot 探测与 Bot 列表都失败时仍返回拓扑，状态降级为不可达", async () => {
    stubIdentityDirectory({
      listOrganizationNames: async () => new Map([["org-1", "研发部"]]),
      listUserDisplayInfo: async () => new Map([["user-1", { id: "user-1", name: "张三", email: "zs@example.com" }]]),
    });
    createChannelTestContext({
      channels: [makeChannel({ id: "channel-1", organizationId: "org-1", userId: "user-1" })],
    });

    const response = await authorized();
    const body = (await response.json()) as {
      success: boolean;
      data: { status: Record<string, unknown>; organizations: { users: { channels: { adapter: null }[] }[] }[] };
    };

    expect(response.status).toBe(200);
    expect(body.data.status).toEqual({
      reachable: false,
      version: null,
      edition: null,
      wizardStatus: null,
    });
    expect(body.data.organizations[0]?.users[0]?.channels[0]?.adapter).toBeNull();
  });
});
