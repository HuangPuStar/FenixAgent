import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebAgentSitesRoutes } from "../server/routes/web/agent-sites";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import { installAgentModuleStub, resetAgentModuleStub, siteAppView } from "./fixtures";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

/**
 * `/web/agent-sites` 协议层用例（成功路径与上游透传）。
 *
 * 授权、可见性与写权限的**规则**不在本文件验收——它们已经是站点 Facade 的职责（见
 * `agent-site-app-facade.test.ts`）；本文件用模块替身声明"应用层返回什么"，断言协议层把它映射成
 * 契约规定的响应体，并把远端调用参数（路径、platform token）原样透传。
 */

const route = createWebAgentSitesRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

const appId = "11111111-1111-4111-8111-111111111111";
const remoteAppId = "app-demo";

let requests: Array<{ url: string; init: RequestInit | undefined }>;
let originalFetch: typeof fetch;

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost/agent-sites${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("round43 Agent Sites Web 路由", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施：DB 句柄经转发代理、站点链路配置经模块配置（见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig({
      agentSitesBaseUrl: "https://agent-sites.test",
      agentSitesMasterKey: "test-master-key",
    });
    resetAgentModuleStub();
    requests = [];
    originalFetch = globalThis.fetch;
    const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: input.toString(), init });
      return new Response(JSON.stringify({ data: { proxied: true } }), {
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(fetchStub, { preconnect: originalFetch.preconnect });
    setTestAuth({ organizationId: "test-org", userId: "test-user" });
  });

  afterEach(() => {
    resetAgentModuleStub();
    globalThis.fetch = originalFetch;
    resetTestAuth();
  });

  // 未认证请求必须在业务处理前被认证守卫拒绝（守卫替身未登录即短路，不进入 handler，也就不触达 Facade）。
  test("未认证访问列表返回 401", async () => {
    resetTestAuth();
    installAgentModuleStub({
      siteFacade: {
        list: async () => {
          throw new Error("未认证请求不应进入应用层");
        },
      },
    });

    expect((await request("/apps")).status).toBe(401);
  });

  // 列表把 Facade 给出的行原样映射为响应，并保留顺序（Facade 已按创建时间排好）。
  test("列表映射 Facade 给出的行并保持顺序", async () => {
    installAgentModuleStub({
      siteFacade: {
        list: async () => [
          siteAppView({ id: "a", name: "app-a", remoteAppId: "app-aaa" }),
          siteAppView({ id: "b", name: "app-b", remoteAppId: "app-bbb" }),
        ],
      },
    });

    const response = await request("/apps");
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.map((item: { remoteAppId: string }) => item.remoteAppId)).toEqual(["app-aaa", "app-bbb"]);
  });

  // 有创建者配置时响应携带创建者名称（前端列表与卡片用它做展示）。
  test("列表附加创建者配置名称", async () => {
    installAgentModuleStub({
      siteFacade: {
        list: async () => [siteAppView({ createdByAgentConfigId: "agent-1", createdByAgentConfigName: "开发智能体" })],
      },
    });

    const body = await (await request("/apps")).json();
    expect(body.data[0].createdByAgentConfigName).toBe("开发智能体");
  });

  // 远端 app id 查询通路（站点识别链路）返回详情；远端 id 原样传给 Facade。
  test("按远端 ID 查询返回详情", async () => {
    const seen: string[] = [];
    installAgentModuleStub({
      siteFacade: {
        getByRemoteAppId: async (_actor, remote) => {
          seen.push(remote);
          return siteAppView({ remoteAppId: "app-remote", visibility: "org", userId: "user-2" });
        },
      },
    });

    const body = await (await request("/apps/by-remote/app-remote")).json();
    expect(body.data).toMatchObject({ remoteAppId: "app-remote", visibility: "org" });
    expect(seen).toEqual(["app-remote"]);
  });

  // 创建请求体经 schema 默认值补齐后交给 Facade，响应体是 Facade 给出的行。
  test("创建把请求字段交给 Facade", async () => {
    const created: Array<Record<string, unknown>> = [];
    installAgentModuleStub({
      siteFacade: {
        create: async (_actor, input) => {
          created.push(input as unknown as Record<string, unknown>);
          return siteAppView({ appType: "custom", visibility: "public" });
        },
      },
    });

    const response = await json("/apps", "POST", {
      name: "created-app",
      type: "custom",
      visibility: "public",
      agentConfigId: "agent-1",
    });

    expect(response.status).toBe(200);
    expect(created).toEqual([{ name: "created-app", visibility: "public", type: "custom", agentConfigId: "agent-1" }]);
  });

  // 不符合 kebab-case 的名称必须被 schema 在进入应用层前拒绝。
  test("创建校验非法名称", async () => {
    installAgentModuleStub({
      siteFacade: {
        create: async () => {
          throw new Error("非法请求不应进入应用层");
        },
      },
    });

    const response = await json("/apps", "POST", { name: "Invalid Name" });
    expect(response.status).toBe(422);
  });

  // 更新把可写字段透传给 Facade，并映射回更新后的行。
  test("更新透传可写字段并返回新行", async () => {
    const updates: Array<Record<string, unknown>> = [];
    installAgentModuleStub({
      siteFacade: {
        update: async (_actor, id, input) => {
          updates.push({ id, ...(input as unknown as Record<string, unknown>) });
          return siteAppView({ name: "new-name", description: "说明", visibility: "org" });
        },
      },
    });

    const response = await json(`/apps/${appId}`, "PATCH", {
      name: "new-name",
      description: "说明",
      visibility: "org",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(updates).toEqual([{ id: appId, name: "new-name", description: "说明", visibility: "org" }]);
    expect(body.data).toMatchObject({ name: "new-name", visibility: "org" });
  });

  // 单文件上传把路径与二进制请求体转交 Facade，并把上游数据原样放进响应。
  test("上传单个文件", async () => {
    const uploads: Array<Record<string, unknown>> = [];
    installAgentModuleStub({
      siteFacade: {
        uploadFile: async (_actor, id, path, body) => {
          uploads.push({ id, path, hasBody: body !== null });
          return { path: "index.html", bytes: 12 };
        },
      },
    });

    const response = await request(`/apps/${appId}/files/index.html`, { method: "PUT", body: "hello" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ path: "index.html", bytes: 12 });
    expect(uploads).toEqual([{ id: appId, path: "index.html", hasBody: true }]);
  });

  // bundle 上传走独立端点，上游返回数据同样原样回给调用方。
  test("批量上传 bundle", async () => {
    installAgentModuleStub({ siteFacade: { uploadBundle: async () => ({ files: [{ path: "a.js", bytes: 1 }] }) } });

    const response = await request(`/apps/${appId}/files/bundle`, { method: "POST", body: "bundle" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ files: [{ path: "a.js", bytes: 1 }] });
  });

  // custom app 部署把平台元数据映射为响应（时间戳降到秒级，与前端契约一致）。
  test("custom app 部署返回秒级元数据", async () => {
    const deployedAt = new Date("2026-08-19T00:00:00.000Z");
    installAgentModuleStub({
      siteFacade: {
        deploy: async () => ({ files: 2, totalBytes: 64, entryFile: "main.ts", slot: "b", deployedAt }),
      },
    });

    const response = await request(`/apps/${appId}/deploy`, { method: "POST", body: "archive" });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      files: 2,
      totalBytes: 64,
      entryFile: "main.ts",
      slot: "b",
      deployedAt: Math.floor(deployedAt.getTime() / 1000),
    });
  });

  // PocketBase 代理注入 platform token，并保留既有契约下的相对路径与 query。
  //
  // 路径拼接沿用迁移前的实现（按 `/web/agent-sites/apps/:id/api/` 前缀做字符串裁剪），既有用例断言的
  // 正是它当前产出的路径——本批不改协议行为，因此断言与迁移前保持一致；该前缀与路由实际挂载前缀不
  // 一致导致的少裁剪问题是既有缺陷，不在本批范围内（见整改回报）。
  test("PocketBase API 代理注入 token 并保留路径", async () => {
    installAgentModuleStub({
      siteFacade: {
        getPocketBaseProxyTarget: async () => ({ remoteAppId, platformToken: "platform-token" }),
      },
    });

    const response = await request(`/apps/${appId}/api/collections/cards?expand=author`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(requests[0]?.url).toContain("/app-demo/api/lections/cards?expand=author");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer platform-token");
  });
});
