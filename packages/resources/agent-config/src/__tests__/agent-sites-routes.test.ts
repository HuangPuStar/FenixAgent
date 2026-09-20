import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WebErrSchema } from "@fenix/platform-sdk";
import { stubDb } from "@fenix/platform-sdk/testing";
import { createWebAgentSitesRoutes } from "../server/routes/web/agent-sites";
import {
  AgentSiteAgentConfigParamsSchema,
  AgentSiteAppDetailResponseSchema,
  AgentSiteAppIdParamsSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteRemoteAppParamsSchema,
  CreateAgentSiteAppRequestSchema,
} from "../server/schemas/agent-site.schema";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import {
  createStubSessionAuthGuardPlugin,
  resetTestAuth,
  setTestActorWithoutOrganization,
  setTestAuth,
} from "./guard-stubs";

const TEST_APP_ID = "00000000-0000-4000-8000-000000000001";
const TEST_REMOTE_APP_ID = "app-abc12345";

const route = createWebAgentSitesRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

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
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
    // 认证状态由包内守卫替身承载（迁移前读宿主 setTestAuth/setTestOrgContext）；组织与角色都由
    // 平台 `ActorContext` 表达，路由侧不再读宿主 AuthContext。
    setTestAuth({ organizationId: "test-org", userId: "test-user" });
    // Stub fetch 避免真实网络请求
    globalThis.fetch = (async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    resetTestAuth();
    globalThis.fetch = originalFetch;
  });

  // 已认证但没有 active organization（API Key 未绑定组织）时返 401：路由读不到组织上下文就不查库，
  // 这条分支迁移前以 `store.authContext!` 解引用无组织对象，表现是 500。
  test("GET /apps 无 active organization 返回 401", async () => {
    setTestActorWithoutOrganization();

    const res = await route.handle(new Request("http://localhost/agent-sites/apps"));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({
      success: false,
      error: { code: "unauthorized", message: "请求缺少组织上下文" },
    });
  });

  // 无任何 app 时返回空数组而不是 404，前端首次进入列表页不应看到错误态。
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
    const res = await route.handle(new Request("http://localhost/agent-sites/apps"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  // 列表投影必须剔除 platformToken，凭据不得随列表泄漏到浏览器。
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
    const res = await route.handle(new Request("http://localhost/agent-sites/apps"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe(TEST_APP_ID);
    // 不返回 platformToken
    expect(json.data[0].platformToken).toBeUndefined();
  });

  // 跨组织的 app 一律按不存在处理（404），不区分「无权限」以免泄漏他组织资源存在性。
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
    const res = await route.handle(new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({
      success: false,
      error: {
        code: "not_found",
        message: "App 不存在",
      },
    });
  });

  // 同组织同用户的 app 返回详情。
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
    const res = await route.handle(new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("my-app");
  });

  // remote app id 查询通路（站点侧回查 RCS 记录）同样要能命中详情。
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
    const res = await route.handle(new Request(`http://localhost/agent-sites/apps/by-remote/${TEST_REMOTE_APP_ID}`));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.remoteAppId).toBe(TEST_REMOTE_APP_ID);
  });

  // 非属主且角色为 member 时拒绝删除：写权限只能来自属主或 org owner/admin。
  test("DELETE /apps/:id 无写权限返回 403（member 角色）", async () => {
    setTestAuth({ organizationId: "test-org", userId: "other-user", role: "member" });

    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow()]),
          }),
        }),
      }),
    });
    const res = await route.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toEqual({
      success: false,
      error: {
        code: "forbidden",
        message: "无权限删除此 app",
      },
    });
  });

  // Agent 未绑定站点时返回空列表，前端据此展示「未绑定」而不是错误。
  test("GET /agent-configs/:id/sites 无绑定时返回空列表", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    });
    const res = await route.handle(new Request("http://localhost/agent-sites/agent-configs/agent-cfg-1/sites"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  // 绑定顺序是用户可见序：repo 批量查询返回乱序时路由必须按绑定顺序重排。
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
    const res = await route.handle(new Request("http://localhost/agent-sites/agent-configs/agent-cfg-1/sites"));
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

  // pocketbase 类型没有用户代码可部署，必须明确拒绝而不是透传到平台失败。
  test("对 pocketbase 类型返 400", async () => {
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
    const res = await route.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("bad_request");
    expect(json.error.message).toContain("不是 custom 类型");
  });

  // 既非属主也非 owner/admin 的用户不得部署他人 app。
  test("非 owner 非 admin 返 403", async () => {
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
    setTestAuth({ organizationId: "test-org", userId: "test-user", role: "member" });
    const res = await route.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      }),
    );
    expect(res.status).toBe(403);
  });

  // ── L2 PB 透传对 custom 类型的拒绝 ─────────────────
  // custom 类型没有 PocketBase，PB 透传应明确返 400 而不是上游 404。

  // custom 类型不含 PocketBase，PB 透传必须本包先拒绝，避免把 404 误报成站点不存在。
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
    const res = await route.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/api/collections`, {
        method: "GET",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("bad_request");
    expect(json.error.message).toContain("不支持 PocketBase API");
  });
});

describe("agent-sites OpenAPI metadata", () => {
  // OpenAPI 文档侧的一半（`Agent Sites` tag 的名称与描述）由宿主插件登记，属宿主测试范围；本包负责
  // 让每条路由都挂上该 tag 与响应 schema——否则文档里的路由会落到无描述的默认分组。
  test("agent-sites 路由统一声明 Agent Sites tag 与列表响应定义", () => {
    const routes = (
      route as unknown as { routes: Array<{ path: string; method: string; hooks: Record<string, unknown> }> }
    ).routes;
    const siteRoutes = routes.filter((item) => item.path.startsWith("/agent-sites"));
    expect(siteRoutes.length).toBeGreaterThan(0);

    const detailed = siteRoutes
      .map((item) => item.hooks.detail as { tags?: string[] } | undefined)
      .filter((detail): detail is { tags?: string[] } => detail !== undefined);
    expect(detailed.length).toBeGreaterThan(0);
    for (const detail of detailed) {
      expect(detail.tags).toContain("Agent Sites");
    }

    const listRoute = routes.find((item) => item.path === "/agent-sites/apps" && item.method === "GET");
    expect(listRoute?.hooks.response).toBeDefined();
  });

  // 关键路由必须显式声明 params/body/response，避免文档与实现脱节。
  test("关键路由显式挂载 schema 元数据", () => {
    const routes = (
      route as unknown as { routes: Array<{ path: string; method: string; hooks: Record<string, unknown> }> }
    ).routes;
    const listRoute = routes.find((route) => route.path === "/agent-sites/apps" && route.method === "GET");
    const createRoute = routes.find((route) => route.path === "/agent-sites/apps" && route.method === "POST");
    const detailRoute = routes.find((route) => route.path === "/agent-sites/apps/:id" && route.method === "GET");
    const detailByRemoteRoute = routes.find(
      (route) => route.path === "/agent-sites/apps/by-remote/:remoteAppId" && route.method === "GET",
    );

    expect(listRoute?.hooks.response).toEqual({
      200: AgentSiteAppListResponseSchema,
      401: WebErrSchema,
    });
    expect(createRoute?.hooks.body).toBe(CreateAgentSiteAppRequestSchema);
    expect(createRoute?.hooks.response).toEqual({
      200: AgentSiteAppDetailResponseSchema,
      401: WebErrSchema,
    });
    expect(detailRoute?.hooks.params).toBe(AgentSiteAppIdParamsSchema);
    expect(detailRoute?.hooks.response).toEqual({
      200: AgentSiteAppDetailResponseSchema,
      401: WebErrSchema,
      404: WebErrSchema,
    });
    expect(detailByRemoteRoute?.hooks.params).toBe(AgentSiteRemoteAppParamsSchema);
    expect(detailByRemoteRoute?.hooks.response).toEqual({
      200: AgentSiteAppDetailResponseSchema,
      401: WebErrSchema,
      404: WebErrSchema,
    });

    const bindingListRoute = routes.find(
      (route) => route.path === "/agent-sites/agent-configs/:agentConfigId/sites" && route.method === "GET",
    );
    expect(bindingListRoute?.hooks.params).toBe(AgentSiteAgentConfigParamsSchema);
  });
});
