import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubAuthApi, stubConfigPg, stubDb } from "../test-utils/helpers";

const route = (await import("../routes/web/agent-sites")).default;

const appId = "11111111-1111-4111-8111-111111111111";
const otherAppId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-08-19T00:00:00.000Z");
let selectResults: unknown[][];
let createdValues: Record<string, unknown> | undefined;
let updatedValues: Record<string, unknown> | undefined;
let deleted = false;
let requests: Array<{ url: string; init: RequestInit | undefined }>;
let originalFetch: typeof fetch;

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: appId,
    organizationId: "org-1",
    userId: "user-1",
    remoteAppId: "app-demo",
    name: "demo-app",
    description: null,
    platformToken: "platform-token",
    platformTokenId: "token-old",
    visibility: "private",
    appType: "pocketbase",
    entryFile: null,
    activeSlot: null,
    deployedAt: null,
    createdByAgentConfigId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function chain(rows: unknown[]) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: Drizzle 查询构造器在 await 时必须是 thenable。
    then(resolve: (value: unknown[]) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
    limit: async () => rows,
    orderBy: async () => rows,
  };
}

function stubRouteDb() {
  stubDb({
    select: () => ({ from: () => ({ where: () => chain(selectResults.shift() ?? []) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          createdValues = values;
          return [app(values)];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updatedValues = values;
            return [app(values)];
          },
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        deleted = true;
        return { count: 1 };
      },
    }),
  });
}

function authenticate(role: "owner" | "admin" | "member" = "owner", userId = "user-1", organizationId = "org-1") {
  setTestAuth({
    user: { id: userId, email: `${userId}@example.test`, name: "Tester" },
    authContext: { organizationId, userId, role },
  });
  setTestOrgContext({ organizationId, userId, role });
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost/agent-sites${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function remoteResponse(url: string) {
  if (url.endsWith("/api/apps") && requests.at(-1)?.init?.method === "POST") {
    return { data: { id: "app-created", name: "created-app", type: "custom" } };
  }
  if (url.endsWith("/api/tokens")) {
    return { data: { token: "token-new", token_id: "token-new-id" } };
  }
  if (url.includes("/deploy")) {
    return { data: { files: 2, total_bytes: 64, entry_file: "main.ts", slot: "b" } };
  }
  if (url.includes("/bundle")) return { data: { files: 2 } };
  if (url.includes("/files/")) return { data: { path: "index.html", bytes: 12 } };
  return { data: { proxied: true } };
}

describe("round43 Agent Sites Web 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    selectResults = [];
    createdValues = undefined;
    updatedValues = undefined;
    deleted = false;
    requests = [];
    process.env.AGENT_SITES_BASE_URL = "https://agent-sites.test";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
    originalFetch = globalThis.fetch;
    const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      requests.push({ url, init });
      return new Response(JSON.stringify(remoteResponse(url)), { headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(fetchStub, { preconnect: originalFetch.preconnect });
    stubRouteDb();
    authenticate();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 未认证请求必须在业务处理前被认证守卫拒绝。
  test("未认证访问列表返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });
    expect((await request("/apps")).status).toBe(401);
  });

  // 列表仅展示当前用户可读的 private app，同时保留组织可见 app。
  test("列表过滤其他用户的 private app", async () => {
    selectResults = [
      [
        app(),
        app({ id: otherAppId, userId: "user-2", remoteAppId: "app-private" }),
        app({
          id: "33333333-3333-4333-8333-333333333333",
          userId: "user-2",
          remoteAppId: "app-org",
          visibility: "org",
        }),
      ],
    ];
    const response = await request("/apps");
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((item: { remoteAppId: string }) => item.remoteAppId)).toEqual([
      "app-demo",
      "app-org",
    ]);
  });

  // 有创建者配置时应批量补充创建者名称。
  test("列表附加创建者配置名称", async () => {
    selectResults = [[app({ createdByAgentConfigId: "agent-1" })], [{ id: "agent-1", name: "开发智能体" }]];
    const body = await (await request("/apps")).json();
    expect(body.data[0].createdByAgentConfigName).toBe("开发智能体");
  });

  // 不存在的 UUID 详情必须映射为统一 not_found 错误。
  test("详情不存在返回 404", async () => {
    selectResults = [[]];
    const response = await request(`/apps/${appId}`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  // 跨组织的记录即使按 ID 查到也不得泄露详情。
  test("详情拒绝跨组织 app", async () => {
    selectResults = [[app({ organizationId: "org-2" })]];
    expect((await request(`/apps/${appId}`)).status).toBe(404);
  });

  // 非创建者不能读取同组织 private app。
  test("详情拒绝其他用户的 private app", async () => {
    selectResults = [[app({ userId: "user-2" })]];
    expect((await request(`/apps/${appId}`)).status).toBe(404);
  });

  // 远端 app id 查询可返回组织范围内公开可读 app。
  test("按远端 ID 查询组织可见 app", async () => {
    selectResults = [[app({ remoteAppId: "app-remote", visibility: "org", userId: "user-2" })]];
    const body = await (await request("/apps/by-remote/app-remote")).json();
    expect(body.data).toMatchObject({ remoteAppId: "app-remote", visibility: "org" });
  });

  // 创建 custom app 要串联远端创建、token 申请和本地持久化。
  test("创建 custom app 持久化远端 token 与归属", async () => {
    const response = await json("/apps", "POST", {
      name: "created-app",
      type: "custom",
      visibility: "public",
      agentConfigId: "agent-1",
    });
    expect(response.status).toBe(200);
    expect(createdValues).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-created",
      platformToken: "token-new",
      appType: "custom",
      visibility: "public",
      createdByAgentConfigId: "agent-1",
    });
  });

  // 不符合 kebab-case 的名称必须被 schema 在远端调用前拒绝。
  test("创建校验非法名称", async () => {
    const response = await json("/apps", "POST", { name: "Invalid Name" });
    expect(response.status).toBe(422);
    expect(requests).toHaveLength(0);
  });

  // 更新不存在 app 时不能执行写入。
  test("更新不存在 app 返回 404", async () => {
    selectResults = [[]];
    expect((await json(`/apps/${appId}`, "PATCH", { name: "new-name" })).status).toBe(404);
    expect(updatedValues).toBeUndefined();
  });

  // 普通成员不能修改其他用户创建的 app。
  test("成员不能更新他人 app", async () => {
    authenticate("member");
    selectResults = [[app({ userId: "user-2" })]];
    expect((await json(`/apps/${appId}`, "PATCH", { name: "new-name" })).status).toBe(403);
  });

  // owner 可以更新名称、描述与可见性。
  test("owner 更新 app 属性", async () => {
    selectResults = [[app()]];
    const response = await json(`/apps/${appId}`, "PATCH", {
      name: "new-name",
      description: "说明",
      visibility: "org",
    });
    expect(response.status).toBe(200);
    expect(updatedValues).toMatchObject({ name: "new-name", description: "说明", visibility: "org" });
  });

  // 删除跨组织 app 时不能触发远端删除。
  test("删除跨组织 app 返回 404", async () => {
    selectResults = [[app({ organizationId: "org-2" })]];
    expect((await request(`/apps/${appId}`, { method: "DELETE" })).status).toBe(404);
    expect(requests).toHaveLength(0);
  });

  // admin 可删除他人 app，且远端删除先于本地硬删除。
  test("admin 删除 app", async () => {
    authenticate("admin");
    selectResults = [[app({ userId: "user-2" })]];
    const response = await request(`/apps/${appId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(requests[0]?.url).toContain("/api/apps/app-demo");
    expect(deleted).toBe(true);
  });

  // 旧 token 吊销失败不应阻止申请新 token 并更新本地记录。
  test("重签 token 在吊销失败后继续", async () => {
    selectResults = [[app()]];
    const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      requests.push({ url, init });
      if (url.includes("token-old")) return new Response(JSON.stringify({ message: "gone" }), { status: 404 });
      return new Response(JSON.stringify(remoteResponse(url)), { headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(fetchStub, { preconnect: originalFetch.preconnect });
    expect((await request(`/apps/${appId}/rotate-token`, { method: "POST" })).status).toBe(200);
    expect(updatedValues).toMatchObject({ platformToken: "token-new", platformTokenId: "token-new-id" });
  });

  // 单文件上传将路径和二进制请求体转交上游。
  test("上传单个文件", async () => {
    selectResults = [[app()]];
    const response = await request(`/apps/${appId}/files/index.html`, { method: "PUT", body: "hello" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ path: "index.html", bytes: 12 });
  });

  // bundle 上传使用独立上游端点并返回平台数据。
  test("批量上传 bundle", async () => {
    selectResults = [[app()]];
    const response = await request(`/apps/${appId}/files/bundle`, { method: "POST", body: "bundle" });
    expect(response.status).toBe(200);
    expect(requests[0]?.url).toContain("/bundle");
  });

  // PocketBase app 不支持 custom deploy，应在调用平台前拒绝。
  test("PocketBase app 拒绝部署", async () => {
    selectResults = [[app()]];
    expect((await request(`/apps/${appId}/deploy`, { method: "POST", body: "archive" })).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  // custom app 部署将平台元数据写回本地并返回秒级时间。
  test("custom app 部署写入元数据", async () => {
    selectResults = [[app({ appType: "custom" })]];
    const response = await request(`/apps/${appId}/deploy`, { method: "POST", body: "archive" });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(updatedValues).toMatchObject({ entryFile: "main.ts", activeSlot: "b" });
    expect(body.data).toMatchObject({ files: 2, totalBytes: 64, slot: "b" });
  });

  // 绑定前先确认 agent config 在当前组织内。
  test("绑定不存在 agent config 返回 404", async () => {
    stubConfigPg({ getAgentConfigById: async () => undefined });
    expect((await request(`/agent-configs/agent-1/sites/${appId}`, { method: "POST" })).status).toBe(404);
  });

  // remoteAppId 绑定必须解析为本地 UUID 后写入关系表。
  test("按远端 ID 绑定 site", async () => {
    let bound: string | undefined;
    stubConfigPg({
      getAgentConfigById: async () => ({ id: "agent-1" }),
      addAgentSiteApp: async (_agentId, siteId) => {
        bound = siteId;
      },
    });
    selectResults = [[app()]];
    const response = await request("/agent-configs/agent-1/sites/app-demo", { method: "POST" });
    expect(response.status).toBe(200);
    expect(bound).toBe(appId);
  });

  // UUID 绑定使用本地 ID 查询路径，避免将 UUID 当作远端 ID。
  test("按 UUID 解绑 site", async () => {
    let removed: string | undefined;
    stubConfigPg({
      getAgentConfigById: async () => ({ id: "agent-1" }),
      removeAgentSiteApp: async (_agentId, siteId) => {
        removed = siteId;
      },
    });
    selectResults = [[app()]];
    expect((await request(`/agent-configs/agent-1/sites/${appId}`, { method: "DELETE" })).status).toBe(200);
    expect(removed).toBe(appId);
  });

  // custom app 不得进入 PocketBase 管理 API 代理。
  test("custom app 拒绝 PocketBase API 代理", async () => {
    selectResults = [[app({ appType: "custom" })]];
    expect((await request(`/apps/${appId}/api/collections/cards`, { method: "GET" })).status).toBe(400);
  });

  // PocketBase 代理注入平台 token 并保留完整相对 API 路径。
  test("PocketBase API 代理注入 token", async () => {
    selectResults = [[app()]];
    const response = await request(`/apps/${appId}/api/collections/cards?expand=author`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(requests[0]?.url).toContain("/app-demo/api/lections/cards?expand=author");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer platform-token");
  });
});
