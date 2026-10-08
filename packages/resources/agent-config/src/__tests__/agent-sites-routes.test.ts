import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WebErrSchema } from "@fenix/platform-sdk";
import { SiteAppActionError } from "../server/facades/agent-site-app-facade";
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
import { installAgentModuleStub, resetAgentModuleStub, siteAppView } from "./fixtures";
import {
  createStubSessionAuthGuardPlugin,
  resetTestAuth,
  setTestActorWithoutOrganization,
  setTestAuth,
} from "./guard-stubs";

/**
 * `/web/agent-sites` 协议层用例（错误映射、DTO 投影与绑定接口的形状）。
 *
 * 授权与可见性规则不在本文件验收：主体解析、发布范围读口径、写权限与创建规则都在站点 Facade 里
 * （见 `agent-site-app-facade.test.ts`），这里用模块替身只声明"应用层返回什么 / 抛什么"，断言协议层
 * 把它映射成契约规定的状态码、错误码与响应体。路由把 `store.actor` 原样交给 Facade 这件事，由
 * `capturedActor` 断言。
 */

const route = createWebAgentSitesRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

const TEST_APP_ID = "00000000-0000-4000-8000-000000000001";
const TEST_REMOTE_APP_ID = "app-abc12345";

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost/agent-sites${path}`, init));
}

describe("agent-sites 协议层", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
    resetAgentModuleStub();
    // 认证状态由包内守卫替身承载；组织与角色都由平台 `ActorContext` 表达。
    setTestAuth({ organizationId: "test-org", userId: "test-user" });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    resetTestAuth();
    resetAgentModuleStub();
    globalThis.fetch = originalFetch;
  });

  // 已认证但没有 active organization（API Key 未绑定组织）时 Facade 抛 no_organization，协议层映射为
  // 401 + unauthorized 文案；这条分支迁移前以 `store.authContext!` 解引用无组织对象，表现是 500。
  test("GET /apps 无组织上下文返回 401", async () => {
    setTestActorWithoutOrganization();
    installAgentModuleStub({
      siteFacade: {
        list: async () => {
          throw new SiteAppActionError("no_organization");
        },
      },
    });

    const res = await request("/apps");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "unauthorized", message: "请求缺少组织上下文" },
    });
  });

  // 无任何 app 时返回空数组而不是 404，前端首次进入列表页不应看到错误态。
  test("GET /apps 返回空列表", async () => {
    installAgentModuleStub({ siteFacade: { list: async () => [] } });

    const res = await request("/apps");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  // 列表投影必须剔除 platformToken，凭据不得随列表泄漏到浏览器；主体必须原样交给 Facade。
  test("GET /apps 返回列表且不含 platformToken", async () => {
    let capturedActor: unknown;
    installAgentModuleStub({
      siteFacade: {
        list: async (actor) => {
          capturedActor = actor;
          return [siteAppView({ createdByAgentConfigId: "agent-1", createdByAgentConfigName: "开发智能体" })];
        },
      },
    });

    const json = await (await request("/apps")).json();

    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe("11111111-1111-4111-8111-111111111111");
    expect(json.data[0].platformToken).toBeUndefined();
    expect(json.data[0].createdByAgentConfigName).toBe("开发智能体");
    expect(capturedActor).toMatchObject({ userId: "test-user", activeOrganizationId: "test-org" });
  });

  // 详情不可见（跨组织或他人 private）与不存在同样映射为 404 not_found。
  test("GET /apps/:id 未命中返回 404", async () => {
    installAgentModuleStub({
      siteFacade: {
        getById: async () => {
          throw new SiteAppActionError("site_not_found");
        },
      },
    });

    const res = await request(`/apps/${TEST_APP_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "not_found", message: "App 不存在" },
    });
  });

  // 远端 app id 查询通路（站点识别链路）同样映射详情响应。
  test("GET /apps/by-remote/:remoteAppId 返回详情", async () => {
    installAgentModuleStub({
      siteFacade: { getByRemoteAppId: async () => siteAppView({ remoteAppId: TEST_REMOTE_APP_ID }) },
    });

    const json = await (await request(`/apps/by-remote/${TEST_REMOTE_APP_ID}`)).json();
    expect(json.data.remoteAppId).toBe(TEST_REMOTE_APP_ID);
  });

  // 无写权限时按端点文案返回 403：同一条 forbidden 语义在不同动作上有不同说法（既有契约）。
  test("DELETE /apps/:id 无写权限返回 403", async () => {
    installAgentModuleStub({
      siteFacade: {
        remove: async () => {
          throw new SiteAppActionError("forbidden");
        },
      },
    });

    const res = await request(`/apps/${TEST_APP_ID}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "forbidden", message: "无权限删除此 app" },
    });
  });

  // 上传端点的 403 文案与其他端点区分（"无权限上传文件"）。
  test("PUT /apps/:id/files/:path 无写权限返回 403 上传文案", async () => {
    installAgentModuleStub({
      siteFacade: {
        uploadFile: async () => {
          throw new SiteAppActionError("forbidden");
        },
      },
    });

    const res = await request(`/apps/${TEST_APP_ID}/files/index.html`, { method: "PUT", body: "hello" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("无权限上传文件");
  });

  // 非 custom 类型的部署拒绝必须带上 app 与当前类型，便于调用方定位（既有文案）。
  test("POST /apps/:id/deploy 非 custom 返回 400 并带类型", async () => {
    installAgentModuleStub({
      siteFacade: {
        deploy: async () => {
          throw new SiteAppActionError("not_custom", { remoteAppId: TEST_REMOTE_APP_ID, appType: "pocketbase" });
        },
      },
    });

    const res = await request(`/apps/${TEST_APP_ID}/deploy`, { method: "POST", body: "archive" });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("bad_request");
    expect(json.error.message).toContain("不是 custom 类型，无法部署");
    expect(json.error.message).toContain(TEST_REMOTE_APP_ID);
  });

  // custom 类型没有 PocketBase：PB 透传本包先 400，避免把上游 404 误报成站点不存在。
  test("ALL /apps/:id/api/* custom 类型返回 400", async () => {
    installAgentModuleStub({
      siteFacade: {
        getPocketBaseProxyTarget: async () => {
          throw new SiteAppActionError("pocketbase_unsupported", {
            remoteAppId: TEST_REMOTE_APP_ID,
            appType: "custom",
          });
        },
      },
    });

    const res = await request(`/apps/${TEST_APP_ID}/api/collections`, { method: "GET" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("不支持 PocketBase API");
  });

  // Agent 未绑定站点时返回空数组，前端据此展示「未绑定」而不是错误；绑定为空时不应查站点。
  test("GET /agent-configs/:id/sites 无绑定时返回空列表", async () => {
    installAgentModuleStub({ siteFacade: { listBoundApps: async () => [] } });

    const res = await request("/agent-configs/agent-cfg-1/sites");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
  });

  // 绑定顺序是用户可见序：Facade 已经按绑定顺序返回，协议层必须原样保留。
  test("GET /agent-configs/:id/sites 保持 Facade 给出的顺序", async () => {
    installAgentModuleStub({
      siteFacade: {
        listBoundApps: async () => [
          siteAppView({ id: "00000000-0000-4000-8000-00000000000b", name: "app-b", remoteAppId: "app-bbb" }),
          siteAppView({ id: "00000000-0000-4000-8000-00000000000a", name: "app-a", remoteAppId: "app-aaa" }),
        ],
      },
    });

    const json = await (await request("/agent-configs/agent-cfg-1/sites")).json();
    expect(json.data.map((item: { name: string }) => item.name)).toEqual(["app-b", "app-a"]);
  });

  // 绑定接口的两个 404 语义各有文案：Agent 配置不存在 / Site 不存在。
  test("POST /agent-configs/:id/sites/:siteAppId 的两种 404 文案", async () => {
    installAgentModuleStub({
      siteFacade: {
        bind: async () => {
          throw new SiteAppActionError("agent_not_found");
        },
      },
    });
    const agentMissing = await request(`/agent-configs/agent-1/sites/${TEST_APP_ID}`, { method: "POST" });
    expect(agentMissing.status).toBe(404);
    expect((await agentMissing.json()).error.message).toBe("Agent 配置不存在");

    installAgentModuleStub({
      siteFacade: {
        bind: async () => {
          throw new SiteAppActionError("site_not_found");
        },
      },
    });
    const siteMissing = await request(`/agent-configs/agent-1/sites/${TEST_APP_ID}`, { method: "POST" });
    expect(siteMissing.status).toBe(404);
    expect((await siteMissing.json()).error.message).toBe("Site 不存在");
  });

  // 解绑走同一套映射；DELETE 天然幂等，成功体是 data: null。
  test("DELETE /agent-configs/:id/sites/:siteAppId 成功返回 null", async () => {
    const unbound: string[] = [];
    installAgentModuleStub({
      siteFacade: {
        unbind: async (_actor, agentConfigId, siteAppId) => {
          unbound.push(`${agentConfigId}/${siteAppId}`);
        },
      },
    });

    const res = await request(`/agent-configs/agent-1/sites/${TEST_APP_ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: null });
    expect(unbound).toEqual([`agent-1/${TEST_APP_ID}`]);
  });
});

describe("agent-sites OpenAPI metadata", () => {
  // OpenAPI 文档侧的一半（`Agent Sites` tag 的名称与描述）由宿主插件登记，属宿主测试范围；本包负责
  // 让每条路由都挂上该 tag 与响应 schema——否则文档里的路由会落到无描述的默认分组。
  test("agent-sites 路由统一声明 Agent Sites tag 与列表响应定义", () => {
    const routes = (
      route as unknown as { routes: Array<{ path: string; method: string; hooks: Record<string, unknown> }> }
    ).routes;

    const agentSitesRoutes = routes.filter((item) => item.path.startsWith("/agent-sites/"));
    expect(agentSitesRoutes.length).toBeGreaterThan(0);
    for (const item of agentSitesRoutes) {
      const detail = item.hooks.detail as { tags?: string[] } | undefined;
      expect(detail?.tags).toContain("Agent Sites");
    }

    const listRoute = agentSitesRoutes.find((item) => item.method === "GET" && item.path === "/agent-sites/apps");
    expect(listRoute).toBeDefined();
    const response = listRoute?.hooks.response as Record<number, unknown> | undefined;
    expect(response?.[200]).toBe(AgentSiteAppListResponseSchema);
  });

  // 参数与请求体 schema 的绑定是协议契约的一部分：路径参数与创建请求体必须各挂各的 schema。
  test("详情/绑定/创建路由挂载各自的参数与请求体 schema", () => {
    const routes = (
      route as unknown as { routes: Array<{ path: string; method: string; hooks: Record<string, unknown> }> }
    ).routes;
    const byId = routes.find((item) => item.path === "/agent-sites/apps/:id" && item.method === "GET");
    expect((byId?.hooks.params as unknown) ?? undefined).toBe(AgentSiteAppIdParamsSchema);
    const byRemote = routes.find((item) => item.path === "/agent-sites/apps/by-remote/:remoteAppId");
    expect((byRemote?.hooks.params as unknown) ?? undefined).toBe(AgentSiteRemoteAppParamsSchema);
    const create = routes.find((item) => item.path === "/agent-sites/apps" && item.method === "POST");
    expect((create?.hooks.body as unknown) ?? undefined).toBe(CreateAgentSiteAppRequestSchema);
    const bindings = routes.find((item) => item.path === "/agent-sites/agent-configs/:agentConfigId/sites");
    expect((bindings?.hooks.params as unknown) ?? undefined).toBe(AgentSiteAgentConfigParamsSchema);

    // 错误响应使用统一信封：所有写端点都声明了 401/403/404（列表与详情只声明到它们会产生的码）。
    const patch = routes.find((item) => item.path === "/agent-sites/apps/:id" && item.method === "PATCH");
    const response = patch?.hooks.response as Record<number, unknown> | undefined;
    expect(response?.[401]).toBe(WebErrSchema);
    expect(response?.[403]).toBe(WebErrSchema);
    expect(response?.[404]).toBe(WebErrSchema);
    expect(response?.[200]).toBe(AgentSiteAppDetailResponseSchema);
  });
});
