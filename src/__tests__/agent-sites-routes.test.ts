import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Elysia from "elysia";
import { createWebOpenApiPlugin } from "../openapi";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import webAgentSites from "../routes/web/agent-sites";
import {
  AgentSiteAgentConfigParamsSchema,
  AgentSiteAppDetailResponseSchema,
  AgentSiteAppIdParamsSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteErrorResponseSchema,
  AgentSiteRemoteAppParamsSchema,
  CreateAgentSiteAppRequestSchema,
} from "../schemas/agent-site.schema";
import { clearOrgCache, setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const TEST_APP_ID = "00000000-0000-4000-8000-000000000001";
const TEST_REMOTE_APP_ID = "app-abc12345";

function makeAppRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_APP_ID,
    organizationId: "test-org",
    userId: "test-user",
    remoteAppId: TEST_REMOTE_APP_ID,
    name: "my-app",
    description: null,
    platformToken: "tok-xxx.yyy",
    platformTokenId: "tok-001",
    visibility: "private",
    appType: "pocketbase",
    entryFile: null,
    activeSlot: null,
    deployedAt: null,
    createdAt: new Date("2026-06-23"),
    updatedAt: new Date("2026-06-23"),
    ...overrides,
  };
}

describe("agent-sites L1 routes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-org", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-org", userId: "test-user", role: "owner" });
    // Stub fetch 避免真实网络请求
    globalThis.fetch = (async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    clearOrgCache();
    globalThis.fetch = originalFetch;
  });

  test("GET /apps 返回空列表", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request("http://localhost/agent-sites/apps"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  test("GET /apps 返回 app 列表（不含 platformToken）", async () => {
    const row = makeAppRow();
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request("http://localhost/agent-sites/apps"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe(TEST_APP_ID);
    // 不返回 platformToken
    expect(json.data[0].platformToken).toBeUndefined();
  });

  test("GET /apps/:id org 不匹配返回 404", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow({ organizationId: "other-org" })]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`));
    expect(res.status).toBe(404);
  });

  test("GET /apps/:id 匹配返回详情", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow()]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("my-app");
  });

  test("GET /apps/by-remote/:remoteAppId 匹配返回详情", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow()]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/by-remote/${TEST_REMOTE_APP_ID}`),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.remoteAppId).toBe(TEST_REMOTE_APP_ID);
  });

  test("DELETE /apps/:id 无写权限返回 403（member 角色）", async () => {
    setTestAuth({
      user: { id: "other-user", email: "other@test.com", name: "Other" },
      authContext: { organizationId: "test-org", userId: "other-user", role: "member" },
    });
    setTestOrgContext({ organizationId: "test-org", userId: "other-user", role: "member" });

    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow()]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
  });

  test("GET /agent-configs/:id/sites 无绑定时返回空列表", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request("http://localhost/agent-sites/agent-configs/agent-cfg-1/sites"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  test("GET /agent-configs/:id/sites 返回绑定 sites 详情（保持绑定顺序）", async () => {
    const siteAppIdA = "00000000-0000-4000-8000-00000000000a";
    const siteAppIdB = "00000000-0000-4000-8000-00000000000b";
    const selectCalls: Array<{ cols: unknown[]; cond?: unknown }> = [];
    // 模拟两次 select：
    //   1) 拿绑定 siteAppId（顺序 [B, A]）
    //   2) repo.listByIds 返回 [A, B]（乱序），路由层应按绑定顺序重排
    let selectCount = 0;
    stubDb({
      select: (cols: unknown[]) => {
        selectCalls.push({ cols });
        selectCount += 1;
        if (selectCount === 1) {
          // 绑定查询：返回 B 在前
          return {
            from: () => ({
              where: () => Promise.resolve([{ siteAppId: siteAppIdB }, { siteAppId: siteAppIdA }]),
            }),
          };
        }
        // repo.listByIds
        return {
          from: () => ({
            where: () =>
              Promise.resolve([
                makeAppRow({ id: siteAppIdA, name: "app-a", remoteAppId: "app-aaa" }),
                makeAppRow({ id: siteAppIdB, name: "app-b", remoteAppId: "app-bbb" }),
              ]),
          }),
        };
      },
    });
    const res = await webAgentSites.handle(new Request("http://localhost/agent-sites/agent-configs/agent-cfg-1/sites"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    // 保持绑定顺序：先 B 后 A
    expect(json.data[0].id).toBe(siteAppIdB);
    expect(json.data[1].id).toBe(siteAppIdA);
    expect(json.data[0].remoteAppId).toBe("app-bbb");
  });

  // ── Custom App 部署（POST /apps/:id/deploy）─────────
  // 仅 type=custom 的 app 支持部署；透传 gzip tar.gz 到 agent-sites 平台，
  // 平台做解压 + TCP 探活 + 双槽位切换。RCS 写回 entry_file/slot/deployed_at。

  test("POST /apps/:id/deploy 对 custom 类型部署成功", async () => {
    const row = makeAppRow({ appType: "custom" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...row,
                  entryFile: "main.ts",
                  activeSlot: "a",
                  deployedAt: new Date("2026-07-01T00:00:00Z"),
                },
              ]),
          }),
        }),
      }),
    });
    // mock fetch 返回平台 deploy 响应（覆盖 beforeEach 的默认 stub）
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: { files: 3, total_bytes: 1024, entry_file: "main.ts", slot: "a", port: 9005 },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const tarGzBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x1f, 0x8b]));
        c.close();
      },
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: tarGzBody,
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      files: 3,
      totalBytes: 1024,
      entryFile: "main.ts",
      slot: "a",
      deployedAt: expect.any(Number),
    });
  });

  test("POST /apps/:id/deploy 对 pocketbase 类型返 400", async () => {
    const row = makeAppRow({ appType: "pocketbase" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("bad_request");
    expect(json.error.message).toContain("不是 custom 类型");
  });

  test("POST /apps/:id/deploy 非 owner 非 admin 返 403", async () => {
    const row = makeAppRow({ appType: "custom", userId: "other-user" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    setTestAuth({
      user: { id: "test-user", email: "t@t.com", name: "T" },
      authContext: { organizationId: "test-org", userId: "test-user", role: "member" },
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      }),
    );
    expect(res.status).toBe(403);
  });

  // ── L2 PB 透传对 custom 类型的拒绝 ─────────────────
  // custom 类型没有 PocketBase，PB 透传应明确返 400 而不是上游 404。

  test("L2 PB 透传 /apps/:id/api/* 对 custom 类型返 400", async () => {
    const row = makeAppRow({ appType: "custom" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/api/collections`, {
        method: "GET",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("bad_request");
    expect(json.error.message).toContain("不支持 PocketBase API");
  });
});

describe("agent-sites OpenAPI metadata", () => {
  // OpenAPI 文档应注册 Agent Sites 全局 tag，并暴露路由响应 schema。
  test("web openapi 包含 Agent Sites tag 与列表响应定义", async () => {
    const app = new Elysia().use(createWebOpenApiPlugin("test")).group("/web", (group) => group.use(webAgentSites));

    const res = await app.handle(new Request("http://localhost/docs/openapi/web/json"));
    const json = (await res.json()) as {
      tags?: Array<{ name: string; description?: string }>;
      paths?: Record<string, Record<string, { responses?: unknown }>>;
    };

    expect(json.tags?.some((tag) => tag.name === "Agent Sites" && tag.description)).toBe(true);
    expect(json.paths?.["/web/agent-sites/apps"]?.get?.responses).toBeDefined();
  });

  // 关键路由必须显式声明 params/body/response，避免文档与实现脱节。
  test("关键路由显式挂载 schema 元数据", () => {
    const routes = (
      webAgentSites as unknown as { routes: Array<{ path: string; method: string; hooks: Record<string, unknown> }> }
    ).routes;
    const listRoute = routes.find((route) => route.path === "/agent-sites/apps" && route.method === "GET");
    const createRoute = routes.find((route) => route.path === "/agent-sites/apps" && route.method === "POST");
    const detailRoute = routes.find((route) => route.path === "/agent-sites/apps/:id" && route.method === "GET");
    const detailByRemoteRoute = routes.find(
      (route) => route.path === "/agent-sites/apps/by-remote/:remoteAppId" && route.method === "GET",
    );

    expect(listRoute?.hooks.response).toBe(AgentSiteAppListResponseSchema);
    expect(createRoute?.hooks.body).toBe(CreateAgentSiteAppRequestSchema);
    expect(createRoute?.hooks.response).toBe(AgentSiteAppDetailResponseSchema);
    expect(detailRoute?.hooks.params).toBe(AgentSiteAppIdParamsSchema);
    expect(detailRoute?.hooks.response).toEqual({
      200: AgentSiteAppDetailResponseSchema,
      404: AgentSiteErrorResponseSchema,
    });
    expect(detailByRemoteRoute?.hooks.params).toBe(AgentSiteRemoteAppParamsSchema);
    expect(detailByRemoteRoute?.hooks.response).toEqual({
      200: AgentSiteAppDetailResponseSchema,
      404: AgentSiteErrorResponseSchema,
    });

    const bindingListRoute = routes.find(
      (route) => route.path === "/agent-sites/agent-configs/:agentConfigId/sites" && route.method === "GET",
    );
    expect(bindingListRoute?.hooks.params).toBe(AgentSiteAgentConfigParamsSchema);
  });
});
