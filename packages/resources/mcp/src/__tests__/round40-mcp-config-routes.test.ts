import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@fenix/platform-sdk";
import { readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { createWebMcpConfigRoutes } from "../server/routes/web/config/mcp";
import { authorizedServer, installMcpModuleStub, resetMcpModuleStub, testActor } from "./fixtures";
import { createStubMcpAuthGuardPlugin } from "./guard-stubs";

/**
 * `/web/config/mcp` 协议层用例。
 *
 * 授权、可见性与资源解析都在应用 Facade 内，本文件只覆盖协议层职责：参数校验、请求映射、视图
 * 映射与错误码映射。Facade 行为（工具计数降级、名称优先级、删除事务等）由 `mcp-server-facade`
 * 用例覆盖。
 *
 * 会话守卫由宿主注入（工厂参数），用例注入包内替身并通过它控制 `store.actor`；不再借宿主的
 * `setTestAuth` / `setTestOrgContext` 短路认证——那会让本用例依赖宿主实现。
 */

const guard = createStubMcpAuthGuardPlugin();
const mcpRoute = createWebMcpConfigRoutes({ authGuardPlugin: guard.plugin });

/** 默认主体是 org-1 的 owner；具体组织由 `testActor({ activeOrganizationId })` 指定。 */
function authenticate() {
  guard.setActor(testActor());
}

function request(path: string, init?: RequestInit) {
  return mcpRoute.handle(new Request(`http://localhost${path}`, init));
}

function jsonRequest(path: string, method: string, body: Record<string, unknown>) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("round40 MCP 配置路由", () => {
  beforeEach(() => {
    resetAllStubs();
    resetMcpModuleStub();
    authenticate();
  });

  afterEach(() => {
    guard.setActor(null);
    resetMcpModuleStub();
  });

  // 列表把可信主体（含 active organization 与全量成员关系）原样交给 Facade，协议层不做主体改写。
  test("列表把可信主体交给 Facade 并返回 servers 数组", async () => {
    let received: ActorContext | undefined;
    installMcpModuleStub({
      facade: {
        list: async (actor) => {
          received = actor;
          return { items: [], total: 0 };
        },
      },
    });

    const response = await request("/config/mcp");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: { servers: [] } });
    expect(received).toEqual(testActor());
  });

  // 列表项视图是展示投影 + 归属 scope + 有效动作，跨组织资源按名录补 organizationName。
  test("列表项返回 scope 与 access，并按组织名录补名称", async () => {
    let listedIds: readonly string[] = [];
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
      identity: {
        listOrganizationNames: async (ids) => {
          listedIds = ids;
          return new Map([["org-source", "Source Team"]]);
        },
      },
    });

    const body = (await readJson(await request("/config/mcp"))) as {
      data: { servers: Record<string, unknown>[] };
    };

    expect(listedIds).toEqual(["org-source"]);
    expect(body.data.servers[0]).toEqual({
      id: "mcp-external",
      name: "shared",
      type: "remote",
      enabled: true,
      summary: "https://mcp.example.test",
      toolsCount: 2,
      scope: { organizationId: "org-source", ownerUserId: "user-1", visibility: "public" },
      access: { actions: ["read"] },
      organizationName: "Source Team",
    });
  });

  // 名录查不到归属组织时整字段省略，不返回空串让前端误以为组织名为空。
  test("组织名录缺项时省略 organizationName", async () => {
    installMcpModuleStub({
      facade: { list: async () => ({ items: [authorizedServer()], total: 1 }) },
    });

    const body = (await readJson(await request("/config/mcp"))) as {
      data: { servers: Record<string, unknown>[] };
    };

    expect(body.data.servers[0]).not.toHaveProperty("organizationName");
  });

  // 无主体的请求（未认证，或已认证但没有 active organization）不得进入 Facade：
  // 没有 active organization 就无法定义资源归属。
  test("缺少组织上下文返回 401 且不调用 Facade", async () => {
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

    const response = await request("/config/mcp");

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" },
    });
    expect(called).toBeFalse();
  });

  // 详情按名称原样透传给 Facade，视图形状是配置 + scope + access，不再有旧栈的 resourceAccess。
  test("详情按名称查询并返回 scope 与 access", async () => {
    let received: string | undefined;
    installMcpModuleStub({
      facade: {
        get: async (_actor, nameOrKey) => {
          received = nameOrKey;
          return authorizedServer({ actions: ["read", "update"] });
        },
      },
      identity: { listOrganizationNames: async () => new Map([["org-1", "Current Team"]]) },
    });

    const body = (await readJson(await request("/config/mcp?name=demo"))) as { data: Record<string, unknown> };

    expect(received).toBe("demo");
    expect(body.data).toEqual({
      name: "demo",
      config: { type: "remote", url: "https://mcp.example.test" },
      scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
      access: { actions: ["read", "update"] },
      organizationName: "Current Team",
    });
  });

  // 资源键（org_id/server-uuid）与名称共用同一入口：Facade 负责解析归属组织。
  test("详情支持资源键定位", async () => {
    let received: string | undefined;
    installMcpModuleStub({
      facade: {
        get: async (_actor, nameOrKey) => {
          received = nameOrKey;
          return authorizedServer({ name: "shared", organizationId: "org-source", visibility: "public" });
        },
      },
    });

    const response = await request("/config/mcp?name=org-source/mcp-1");

    expect(response.status).toBe(200);
    expect(received).toBe("org-source/mcp-1");
  });

  // 不可见与不存在都表现为 404，不区分两者以免资源名成为跨组织探测面。
  test("详情不存在返回 404", async () => {
    installMcpModuleStub({ facade: { get: async () => undefined } });

    const response = await request("/config/mcp?name=missing");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "MCP server 'missing' not found" },
    });
  });

  // 名称与配置结构的领域校验归 Facade：它抛出的 ValidationError 在本层映射为 400 校验错误体。
  // 校验规则本身（名称格式、INVALID_URL 等）由 mcp-server-facade 用例覆盖，本层只管映射。
  test("Facade 的领域校验拒绝映射为 400", async () => {
    installMcpModuleStub({
      facade: {
        create: async () => {
          throw new ValidationError(
            "Invalid server name: must be 1-64 lowercase alphanumeric chars with single hyphens",
          );
        },
      },
    });

    const response = await jsonRequest("/config/mcp", "POST", { name: "Bad_Name", config: { type: "local" } });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid server name: must be 1-64 lowercase alphanumeric chars with single hyphens",
      },
    });
  });

  // 创建把 body 级 publicReadable 与从 config 里剥出的公开开关合并后传给 Facade，config 内不留该字段。
  test("创建透传配置与公开读取开关", async () => {
    let received: Record<string, unknown> | undefined;
    installMcpModuleStub({
      facade: {
        create: async (_actor, input) => {
          received = input;
          return "mcp-1";
        },
      },
    });

    const response = await jsonRequest("/config/mcp", "POST", {
      name: "demo",
      config: { type: "remote", url: "https://mcp.example.test", publicReadable: true },
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: { name: "demo" } });
    expect(received).toEqual({
      name: "demo",
      type: "remote",
      config: { type: "remote", url: "https://mcp.example.test" },
      publicReadable: true,
    });
  });

  // 同组织同名冲突由 Facade 抛出，协议层映射为 409 而不是 400。
  test("创建同名冲突返回 409", async () => {
    installMcpModuleStub({
      facade: {
        create: async () => {
          throw new ConflictError("MCP server 'demo' already exists");
        },
      },
    });

    const response = await jsonRequest("/config/mcp", "POST", {
      name: "demo",
      config: { type: "remote", url: "https://mcp.example.test" },
    });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "ALREADY_EXISTS", message: "MCP server 'demo' already exists" },
    });
  });

  // 无 create 动作的主体（例如 member）创建时必须 403，而不是落库后才发现归属非法。
  test("创建被授权拒绝返回 403", async () => {
    installMcpModuleStub({
      facade: {
        create: async () => {
          throw new ForbiddenError("当前主体无权创建该资源");
        },
      },
    });

    const response = await jsonRequest("/config/mcp", "POST", {
      name: "demo",
      config: { type: "remote", url: "https://mcp.example.test" },
    });

    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "FORBIDDEN", message: "当前主体无权创建该资源" },
    });
  });

  // 更新缺少 name 查询参数必须在协议层拒绝：没有定位符就无法确定要改哪个资源。
  test("更新缺少名称返回 400", async () => {
    installMcpModuleStub({ facade: { update: async () => "demo" } });

    const response = await jsonRequest("/config/mcp", "PUT", { config: { type: "remote", url: "https://x.test" } });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "缺少 'name' 查询参数" },
    });
  });

  // 更新把 config 与显式 publicReadable 分开传给 Facade：公开开关不进连接配置。
  test("更新透传配置与公开读取开关", async () => {
    let received: { nameOrKey: string; config: unknown; options: unknown } | undefined;
    installMcpModuleStub({
      facade: {
        update: async (_actor, nameOrKey, config, options) => {
          received = { nameOrKey, config, options };
          return nameOrKey;
        },
      },
    });

    const response = await jsonRequest("/config/mcp?name=demo", "PUT", {
      config: { type: "remote", url: "https://new.example.test", publicReadable: false },
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({
      nameOrKey: "demo",
      config: { type: "remote", url: "https://new.example.test" },
      options: { publicReadable: false },
    });
  });

  // 更新目标的不可见或不存在统一映射为 404。
  test("更新不存在资源返回 404", async () => {
    installMcpModuleStub({
      facade: {
        update: async () => {
          throw new NotFoundError("MCP server 'missing' not found");
        },
      },
    });

    const response = await jsonRequest("/config/mcp?name=missing", "PUT", {
      config: { type: "remote", url: "https://new.example.test" },
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  // 删除成功返回空 data：删除目标的 tools 缓存清理在同一条 Facade 调用内完成。
  test("删除成功返回空数据", async () => {
    let removed: string | undefined;
    installMcpModuleStub({
      facade: {
        remove: async (_actor, nameOrKey) => {
          removed = nameOrKey;
        },
      },
    });

    const response = await request("/config/mcp?name=demo", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: null });
    expect(removed).toBe("demo");
  });

  // 其他组织的公开资源可读但不可删，协议层必须映射为 403 而不是 404。
  test("删除外部资源返回 403", async () => {
    installMcpModuleStub({
      facade: {
        remove: async () => {
          throw new ForbiddenError("当前主体无权执行资源动作");
        },
      },
    });

    const response = await request("/config/mcp?name=shared", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
  });

  // 历史配置丢失了 type 时不得被当成可启用资源：启用前必须能判定其类型。
  test("启用缺少类型的历史配置返回 400", async () => {
    let enabled = false;
    installMcpModuleStub({
      facade: {
        getWritable: async () => authorizedServer({ config: { enabled: false } }),
        setEnabled: async () => {
          enabled = true;
          return "demo";
        },
      },
    });

    const response = await request("/config/mcp/actions/enable?name=demo", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Cannot enable 'demo': original config lost, please recreate" },
    });
    expect(enabled).toBeFalse();
  });

  // 启用与禁用都以可写资源的原始配置为前提，并把目标状态交给 Facade。
  test("启用与禁用传递目标状态", async () => {
    const calls: boolean[] = [];
    installMcpModuleStub({
      facade: {
        getWritable: async () => authorizedServer(),
        setEnabled: async (_actor, _nameOrKey, enabled) => {
          calls.push(enabled);
          return "demo";
        },
      },
    });

    const enabledBody = await readJson(await request("/config/mcp/actions/enable?name=demo", { method: "POST" }));
    const disabledBody = await readJson(await request("/config/mcp/actions/disable?name=demo", { method: "POST" }));

    expect(calls).toEqual([true, false]);
    expect(enabledBody).toEqual({ success: true, data: { name: "demo", enabled: true } });
    expect(disabledBody).toEqual({ success: true, data: { name: "demo", enabled: false } });
  });

  // 需要原始配置的动作（启停、连接检测）都要求可写资源：可见但无 update 动作时返回 403。
  test("启停与检测对无权资源返回 403", async () => {
    const denied = async () => {
      throw new ForbiddenError("当前主体无权执行资源动作");
    };
    installMcpModuleStub({ facade: { getWritable: denied, setEnabled: denied } });

    for (const action of ["enable", "disable", "test"]) {
      const response = await request(`/config/mcp/actions/${action}?name=shared`, { method: "POST" });

      expect(response.status).toBe(403);
      expect(await readJson(response)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    }
  });

  // 工具清单以资源键查询时也必须返回资源自身名称，否则前端会拿资源键与列表项对不上。
  test("工具清单返回资源自身名称", async () => {
    installMcpModuleStub({
      facade: {
        listTools: async () => ({
          name: "shared",
          tools: [
            {
              id: "tool-1",
              organizationId: "org-source",
              serverName: "shared",
              toolName: "audit",
              description: "读取审计日志",
              inputSchema: { type: "object" },
              inspectedAt: new Date("2026-08-19T01:00:00.000Z"),
            },
          ],
        }),
      },
    });

    const body = await readJson(await request("/config/mcp/actions/tools?name=org-source/mcp-1"));

    expect(body).toEqual({
      success: true,
      data: {
        name: "shared",
        tools: [
          {
            id: "tool-1",
            toolName: "audit",
            description: "读取审计日志",
            inputSchema: { type: "object" },
            inspectedAt: Date.parse("2026-08-19T01:00:00.000Z"),
          },
        ],
      },
    });
  });

  // 非 AppError 的未知异常必须上抛为 500，不能被伪装成权限或校验失败。
  test("未知异常返回 500", async () => {
    installMcpModuleStub({
      facade: {
        list: async () => {
          throw new Error("storage failed");
        },
      },
    });

    expect((await request("/config/mcp")).status).toBe(500);
  });
});
