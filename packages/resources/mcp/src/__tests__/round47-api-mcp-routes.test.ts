import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { AppError, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { createApiMcpRoutes } from "../server/routes/api/mcp";
import { authorizedServer, installMcpModuleStub, resetMcpModuleStub, testActor } from "./fixtures";
import { createStubMcpAuthGuardPlugin } from "./guard-stubs";

/**
 * `/api/mcp` 协议层用例（对外已发布合同）。
 *
 * 关注两点：一是分页与计数由 Facade/数据库完成（协议层不再内存切片），二是 `resourceAccess` 由
 * `toResourceAccessView` 从 `scope + access.actions` 派生——它是唯一保留旧字段形状的位置。
 *
 * 会话守卫由宿主注入（工厂参数），主体由包内替身控制；真实守卫的凭据解析不在本文件覆盖范围。
 */

const guard = createStubMcpAuthGuardPlugin();
const route = createApiMcpRoutes({ authGuardPlugin: guard.plugin });

function authenticate() {
  guard.setActor(testActor());
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost/api/mcp${path}`, init));
}

function jsonRequest(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("round47 API MCP 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    resetMcpModuleStub();
    authenticate();
  });

  afterEach(() => {
    guard.setActor(null);
    resetMcpModuleStub();
  });

  // 无主体的请求必须被拒，且错误体是平台统一信封（`/api` 的稳定错误形状）。
  test("缺少主体时列表返回 401 且不调用 Facade", async () => {
    let called = false;
    installMcpModuleStub({
      facade: {
        list: async () => {
          called = true;
          return { items: [], total: 0 };
        },
      },
    });
    guard.setActor(null);

    const response = await request("/");

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({ error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    expect(called).toBeFalse();
  });

  // 分页与计数下推到 Facade：协议层只把 page/pageSize 换算成 limit/offset，不再内存切片。
  test("列表把主体与分页下推给 Facade", async () => {
    let received: { actor?: ActorContext; options?: { limit?: number; offset?: number } } = {};
    installMcpModuleStub({
      facade: {
        list: async (actor, options) => {
          received = { actor, options };
          return { items: [authorizedServer()], total: 7 };
        },
      },
    });

    const body = await readJson(await request("/?page=2&pageSize=3"));

    expect(body).toMatchObject({ total: 7, page: 2, pageSize: 3 });
    expect(received.actor).toEqual(testActor());
    expect(received.options).toEqual({ limit: 3, offset: 3 });
  });

  // 跨组织公开资源在对外视图里是 external 且不可写，公开受众由 visibility 表达。
  test("列表把跨组织资源的 scope 与 access 映射为 resourceAccess", async () => {
    installMcpModuleStub({
      facade: {
        list: async () => ({
          items: [
            authorizedServer({
              id: "mcp-external",
              name: "shared",
              organizationId: "org-source",
              visibility: "public",
              actions: ["read"],
              toolsCount: 2,
            }),
          ],
          total: 1,
        }),
      },
      identity: { listOrganizationNames: async () => new Map([["org-source", "Source Team"]]) },
    });

    const body = await readJson(await request("/"));

    expect(body.items[0]).toEqual({
      id: "mcp-external",
      name: "shared",
      type: "remote",
      enabled: true,
      summary: "https://mcp.example.test",
      toolsCount: 2,
      resourceAccess: {
        ownership: "external",
        sourceOrganizationId: "org-source",
        sourceOrganizationName: "Source Team",
        resourceUid: "mcp-external",
        resourceKey: "org-source/mcp-external",
        manageable: false,
        writable: false,
        publicReadable: true,
      },
    });
  });

  // 本组织资源是 internal 且可写；名录未提供组织名时该字段整体省略而不是空串。
  test("列表把本组织资源映射为 internal 且省略缺失的组织名", async () => {
    installMcpModuleStub({
      facade: {
        list: async () => ({ items: [authorizedServer({ actions: ["read", "update"] })], total: 1 }),
      },
    });

    const body = await readJson(await request("/"));

    expect(body.items[0].resourceAccess).toEqual({
      ownership: "internal",
      sourceOrganizationId: "org-1",
      resourceUid: "mcp-1",
      resourceKey: "org-1/mcp-1",
      manageable: true,
      writable: true,
      publicReadable: false,
    });
  });

  // config.type 优先于存储列，streamable-http 必须按配置展示而不是回落成 remote。
  test("列表优先映射 config 中的 streamable-http 类型", async () => {
    installMcpModuleStub({
      facade: {
        list: async () => ({
          items: [
            authorizedServer({
              type: "local",
              config: { type: "streamable-http", url: "https://stream.example.test" },
            }),
          ],
          total: 1,
        }),
      },
    });

    const body = await readJson(await request("/"));

    expect(body.items[0]).toMatchObject({ type: "streamable-http", summary: "https://stream.example.test" });
  });

  // 非法分页参数必须在资源查询前被请求 schema 拒绝，避免把无界查询交给数据库。
  test("非法分页参数返回 422 且不调用 Facade", async () => {
    let called = false;
    installMcpModuleStub({
      facade: {
        list: async () => {
          called = true;
          return { items: [], total: 0 };
        },
      },
    });

    expect((await request("/?page=0")).status).toBe(422);
    expect((await request("/?pageSize=101")).status).toBe(422);
    expect(called).toBeFalse();
  });

  // 详情按路径 ID 委托 Facade，并同样派生对外资源访问字段。
  test("详情按 ID 查询并派生 resourceAccess", async () => {
    let received: string | undefined;
    installMcpModuleStub({
      facade: {
        getById: async (_actor, id) => {
          received = id;
          return authorizedServer({ id, name: "shared", organizationId: "org-source", actions: ["read"] });
        },
      },
    });

    const body = await readJson(await request("/mcp-1"));

    expect(received).toBe("mcp-1");
    expect(body).toMatchObject({
      id: "mcp-1",
      name: "shared",
      config: { type: "remote", url: "https://mcp.example.test" },
      resourceAccess: { ownership: "external", writable: false, resourceKey: "org-source/mcp-1" },
    });
  });

  // 不可见与不存在对外表现一致：都返回 404，不泄露资源是否存在于其他组织。
  test("详情不可见返回 404", async () => {
    installMcpModuleStub({ facade: { getById: async () => undefined } });

    const response = await request("/other-org-resource");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 空路径 ID 不匹配详情路由，必须在进入资源查询前被路由匹配拒绝。
  test("空 ID 不匹配详情路由", async () => {
    installMcpModuleStub({ facade: { getById: async () => undefined } });

    expect((await request("//")).status).toBe(404);
  });

  // 同组织同名已存在时返回 409，避免创建请求静默改写既有配置。
  test("创建重复名称返回 409", async () => {
    let created = false;
    installMcpModuleStub({
      facade: {
        get: async () => authorizedServer(),
        create: async () => {
          created = true;
          return "mcp-1";
        },
      },
    });

    const response = await jsonRequest("/", "POST", { name: "demo" });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: { code: "CONFLICT", message: "MCP server 'demo' already exists" },
    });
    expect(created).toBeFalse();
  });

  // 创建把请求体映射为存储配置：type 与 publicReadable 分开传递，config 内不留公开标记。
  test("创建映射配置与公开读取", async () => {
    let received: Record<string, unknown> | undefined;
    installMcpModuleStub({
      facade: {
        get: async () => undefined,
        create: async (_actor, input) => {
          received = input;
          return "new-id";
        },
        getById: async (_actor, id) =>
          authorizedServer({
            id,
            name: "new",
            config: { type: "remote", url: "https://new.example.test", timeout: 3000 },
          }),
      },
    });

    const response = await jsonRequest("/", "POST", {
      name: "new",
      type: "remote",
      url: "https://new.example.test",
      timeout: 3000,
      publicReadable: true,
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({
      name: "new",
      type: "remote",
      config: { type: "remote", url: "https://new.example.test", timeout: 3000 },
      publicReadable: true,
    });
    expect(await readJson(response)).toMatchObject({ id: "new-id", name: "new" });
  });

  // 创建后重新读取失败必须报内部错误，不能返回半成品详情。
  test("创建后无法重载返回 500", async () => {
    installMcpModuleStub({
      facade: { get: async () => undefined, create: async () => "new-id", getById: async () => undefined },
    });

    const response = await jsonRequest("/", "POST", { name: "new" });

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({
      error: { code: "INTERNAL_ERROR", message: "MCP server could not be reloaded" },
    });
  });

  // 创建请求缺少名称必须被 schema 拒绝且不产生授权与写入。
  test("创建缺少名称返回 422", async () => {
    let called = false;
    installMcpModuleStub({
      facade: {
        get: async () => {
          called = true;
          return;
        },
      },
    });

    expect((await jsonRequest("/", "POST", {})).status).toBe(422);
    expect(called).toBeFalse();
  });

  // 更新通过路径 ID 定位资源：body 不允许重命名，oauth 的 null 清空语义映射为 false。
  test("更新映射配置与公开读取", async () => {
    let received: { id?: string; config?: unknown; options?: unknown } = {};
    installMcpModuleStub({
      facade: {
        updateById: async (_actor, id, config, options) => {
          received = { id, config, options };
          return "mcp-1";
        },
        getById: async () => authorizedServer({ config: { type: "local", command: ["npx", "server"] } }),
      },
    });

    const response = await jsonRequest("/mcp-1", "PUT", {
      command: ["npx", "server"],
      oauth: null,
      publicReadable: false,
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({
      id: "mcp-1",
      config: { type: "local", command: ["npx", "server"], oauth: false },
      options: { publicReadable: false },
    });
  });

  // 更新不存在或不可见资源返回 404；可见但无 update 动作返回 403。
  test("更新映射目标状态错误", async () => {
    installMcpModuleStub({
      facade: {
        updateById: async () => {
          throw new NotFoundError("MCP server 'missing' not found");
        },
      },
    });
    expect((await jsonRequest("/missing", "PUT", { timeout: 1000 })).status).toBe(404);

    installMcpModuleStub({
      facade: {
        updateById: async () => {
          throw new ForbiddenError("当前主体无权执行资源动作");
        },
      },
    });
    const forbidden = await jsonRequest("/shared", "PUT", { timeout: 1000 });
    expect(forbidden.status).toBe(403);
    expect(await readJson(forbidden)).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  // 更新超时为零必须在请求 schema 层拒绝，避免写入不可用的连接配置。
  test("更新的非法超时返回 422", async () => {
    installMcpModuleStub({ facade: { updateById: async () => "mcp-1" } });

    expect((await jsonRequest("/mcp-1", "PUT", { timeout: 0 })).status).toBe(422);
  });

  // 删除返回被删除资源的唯一 ID（对外合同用 ID 而非名称定位）。
  test("删除返回资源 ID", async () => {
    let removed: string | undefined;
    installMcpModuleStub({
      facade: {
        removeById: async (_actor, id) => {
          removed = id;
        },
      },
    });

    const response = await request("/mcp-1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ id: "mcp-1", deleted: true });
    expect(removed).toBe("mcp-1");
  });

  // 删除外部或不存在资源分别以 403 / 404 暴露，不能用同一个状态码混淆两种语义。
  test("删除映射权限与不存在错误", async () => {
    installMcpModuleStub({
      facade: {
        removeById: async () => {
          throw new ForbiddenError("当前主体无权执行资源动作");
        },
      },
    });
    expect((await request("/shared", { method: "DELETE" })).status).toBe(403);

    installMcpModuleStub({
      facade: {
        removeById: async () => {
          throw new NotFoundError("MCP server 'missing' not found");
        },
      },
    });
    expect((await request("/missing", { method: "DELETE" })).status).toBe(404);
  });

  // 业务 AppError 必须保留其对外状态码与错误码，不被统一改写为 500。
  test("列表透传业务错误状态码", async () => {
    installMcpModuleStub({
      facade: {
        list: async () => {
          throw new AppError("denied", "FORBIDDEN", 403);
        },
      },
    });

    const response = await request("/");

    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({ error: { code: "FORBIDDEN", message: "denied" } });
  });

  // 未知异常映射为 INTERNAL_ERROR，保持既有对外错误结构。
  test("删除映射未知错误", async () => {
    installMcpModuleStub({
      facade: {
        removeById: async () => {
          throw new Error("storage failed");
        },
      },
    });

    const response = await request("/mcp-1", { method: "DELETE" });

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: { code: "INTERNAL_ERROR", message: "storage failed" } });
  });
});
