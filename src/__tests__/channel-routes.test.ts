import { describe, expect, mock, test } from "bun:test";

mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "test-user-1", email: "test@test.com", name: "TestUser" },
        session: { id: "sess-1", userId: "test-user-1", token: "tok-1" },
      }),
    },
  },
}));

mock.module("../services/hermes-client", () => ({
  getHermesClient: () => ({
    getStatus: () => ({
      connected: true,
      url: "ws://127.0.0.1:8642/messaging",
      platforms: ["feishu", "telegram"],
      reconnecting: false,
      lastConnectedAt: 1715184000000,
    }),
  }),
}));

mock.module("../services/channel-binding", () => ({
  listBindings: async () => [
    { id: "bind_001", platform: "feishu", chatId: null, agentId: "env_001", enabled: true },
  ],
  createBinding: async (data: any) => ({
    id: "bind_new",
    ...data,
    chatId: data.chatId ?? null,
    enabled: data.enabled ?? true,
  }),
  deleteBinding: async (id: string) => id === "bind_001",
  updateBinding: async (id: string, data: any) =>
    id === "bind_001"
      ? { id: "bind_001", platform: "feishu", chatId: null, agentId: "env_001", enabled: false, ...data }
      : undefined,
}));

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: async (id: string) =>
      id === "env_001"
        ? { id: "env_001", name: "test-agent", workerType: "acp", status: "active" }
        : undefined,
  },
  sessionRepo: {},
  sessionWorkerRepo: {},
  shareLinkRepo: {},
  tokenRepo: {},
  workItemRepo: {},
  resetAllRepos: () => {},
}));

const { default: Elysia } = await import("elysia");
const webChannels = (await import("../routes/web/channels")).default;

const testApp = new Elysia().use(webChannels);

function request(path: string, init?: RequestInit) {
  return testApp.handle(new Request(`http://localhost${path}`, init));
}

describe("channel routes", () => {
  test("GET /web/channels/providers returns disabled providers", async () => {
    const res = await request("/web/channels/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual([
      { type: "wechat", label: "微信", status: "disabled" },
      { type: "feishu", label: "飞书", status: "enabled" },
    ]);
  });

  test("GET /web/channels returns empty list", async () => {
    const res = await request("/web/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual([]);
  });

  test("POST /web/channels rejects all create attempts", async () => {
    for (const type of ["wechat", "feishu"]) {
      const res = await request("/web/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body).toEqual({
        error: { type: "FORBIDDEN", message: "当前平台暂未开放" },
      });
    }
  });

  test("GET /web/channels/hermes/status 返回连接状态", async () => {
    const res = await request("/web/channels/hermes/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.connected).toBe(true);
    expect(body.platforms).toContain("feishu");
    expect(body.platforms).toContain("telegram");
  });

  test("GET /web/channels/bindings 返回补全 agentName 的绑定列表", async () => {
    const res = await request("/web/channels/bindings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toHaveLength(1);
    expect(body[0].agentName).toBe("test-agent");
    expect(body[0].id).toBe("bind_001");
  });

  test("POST /web/channels/bindings 创建绑定成功", async () => {
    const res = await request("/web/channels/bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram", agentId: "env_001" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.id).toMatch(/^bind_/);
    expect(body.platform).toBe("telegram");
  });

  test("POST /web/channels/bindings 缺少必填字段返回 400", async () => {
    const res = await request("/web/channels/bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("VALIDATION_ERROR");
  });

  test("DELETE /web/channels/bindings/bind_001 删除成功", async () => {
    const res = await request("/web/channels/bindings/bind_001", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
  });

  test("DELETE /web/channels/bindings/nonexist 返回 404", async () => {
    const res = await request("/web/channels/bindings/nonexist", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("NOT_FOUND");
  });

  test("PATCH /web/channels/bindings/bind_001 更新绑定", async () => {
    const res = await request("/web/channels/bindings/bind_001", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.enabled).toBe(false);
  });

  test("PATCH /web/channels/bindings/nonexist 返回 404", async () => {
    const res = await request("/web/channels/bindings/nonexist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });
});
