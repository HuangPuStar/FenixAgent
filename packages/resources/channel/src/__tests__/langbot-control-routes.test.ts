import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChannelControlError } from "../server/contracts";
import { createLangBotWebRoutes } from "../server/routes/web/langbot";
import { createChannelTestContext, makeChannel, makeConversation, resetChannelModule } from "./fixtures";
import {
  createStubSessionAuthGuardPlugin,
  resetTestAuth,
  setTestActorWithoutOrganization,
  setTestAuth,
} from "./guard-stubs";

/**
 * `/web/channels/langbot` 的协议契约。
 *
 * 关注四件事：会话鉴权（未认证 / 无组织）、跨组织 404、`/web` 信封与状态码、以及请求体里的密钥不会
 * 通过响应或错误回显。
 */

const route = createLangBotWebRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown>) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BASE = "/channels/langbot";

beforeEach(() => {
  setTestAuth({ organizationId: "org-1", userId: "admin-1" });
});

afterEach(() => {
  resetChannelModule();
  resetTestAuth();
});

describe("LangBot 控制面路由", () => {
  // 未认证请求必须在进入 handler 之前被会话守卫拒绝。
  test("未认证请求返回 401", async () => {
    resetTestAuth();

    const response = await request(`${BASE}/bots`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ success: false });
  });

  // 已认证但没有 active organization 时，门面应以 401 拒绝，而不是用空组织去查数据。
  test("缺少组织上下文时返回 401 信封", async () => {
    setTestActorWithoutOrganization();
    createChannelTestContext();

    const response = await request(`${BASE}/bots`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "UNAUTHORIZED" },
    });
  });

  // 创建请求里的 config 只向上游透传：响应、错误都不能回显它。
  test("创建 Bot 返回 201 且不回显 config", async () => {
    const sentinel = `token-${crypto.randomUUID()}`;
    createChannelTestContext({
      client: {
        createBot: async () => "bot-1",
        getBot: async () => ({
          uuid: "bot-1",
          name: "飞书机器人",
          adapter: "feishu",
          createdAt: null,
          updatedAt: null,
        }),
      },
    });

    const response = await json(`${BASE}/bots`, "POST", {
      name: "飞书机器人",
      adapter: "feishu",
      config: { appSecret: sentinel },
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ success: true, data: { botUuid: "bot-1", name: "飞书机器人" } });
    expect(JSON.stringify(body)).not.toContain(sentinel);
  });

  // LangBot 不可达时给出明确的 503 与稳定错误码，而不是 500 或空列表。
  test("LangBot 不可达返回 LANGBOT_UNREACHABLE", async () => {
    createChannelTestContext({
      client: {
        listBots: async () => {
          throw new ChannelControlError("LANGBOT_UNREACHABLE", 503, "LangBot 不可达或请求超时");
        },
      },
    });

    const response = await request(`${BASE}/bots`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "LANGBOT_UNREACHABLE", message: "LangBot 不可达或请求超时" },
    });
  });

  // 跨组织 Bot 统一 404：不区分「不存在」与「属于别的组织」。
  test("跨组织 Bot 详情返回 404", async () => {
    const botUuid = crypto.randomUUID();
    createChannelTestContext({
      channels: [makeChannel({ organizationId: "org-2", credentials: { botUuid } })],
    });

    const response = await request(`${BASE}/bots/${botUuid}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  // 同一通道 + 聊天类型的重复路由必须映射为 409，而不是让数据库唯一键变成 500。
  test("重复路由返回 409", async () => {
    const channel = makeChannel();
    createChannelTestContext({ channels: [channel] });
    const body = {
      channelId: channel.id,
      chatType: "person",
      chatId: "user-1",
      agentConfigId: crypto.randomUUID(),
    };

    expect((await json(`${BASE}/routes`, "POST", body)).status).toBe(201);
    const response = await json(`${BASE}/routes`, "POST", body);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "ROUTE_CONFLICT" } });
  });

  // config 体积上限按 UTF-8 字节数校验，超限在协议层就返回 400。
  test("超过 64 KiB 的 config 返回 400", async () => {
    createChannelTestContext();

    const response = await json(`${BASE}/bots`, "POST", {
      name: "big",
      adapter: "feishu",
      config: { blob: "x".repeat(70 * 1024) },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "INVALID_INPUT" } });
  });

  // 会话列表返回脱敏键与默认分页参数，不返回聊天正文或 ACP session。
  test("会话列表脱敏并带默认分页", async () => {
    const channel = makeChannel();
    createChannelTestContext({
      channels: [channel],
      conversations: [makeConversation({ channelId: channel.id, rcsSessionId: "rcs_secret_value_1234567890" })],
    });

    const response = await request(`${BASE}/conversations`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(JSON.stringify(body)).not.toContain("secret_value");
    expect(JSON.stringify(body)).not.toContain("ses_");
  });

  // 删除成功返回确认信封，供前端统一按 `{ success, data }` 处理。
  test("删除 Bot 返回 ok 信封", async () => {
    const botUuid = crypto.randomUUID();
    const channel = makeChannel({ credentials: { botUuid } });
    createChannelTestContext({ channels: [channel], client: { deleteBot: async () => {} } });

    const response = await request(`${BASE}/bots/${botUuid}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { ok: true } });
  });

  // 每个端点都必须声明 OpenAPI detail，避免控制面在文档里成为盲区。
  test("所有端点都有 OpenAPI 摘要", () => {
    const routes = route.routes.filter((item) => item.path.startsWith(BASE));

    expect(routes.length).toBeGreaterThanOrEqual(12);
    for (const item of routes) {
      const detail = (item.hooks as { detail?: { summary?: string } }).detail;
      expect(detail?.summary).toBeTruthy();
    }
  });
});
