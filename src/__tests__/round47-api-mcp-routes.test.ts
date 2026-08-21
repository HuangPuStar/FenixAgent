import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { readJson, resetAllStubs, stubAuthApi, stubConfigPg, stubDb, stubEnvironmentRepo } from "../test-utils/helpers";

const route = (await import("../routes/api/mcp")).default;
const now = new Date("2026-08-19T00:00:00.000Z");

function server(overrides: Record<string, unknown> = {}) {
  return {
    id: "mcp-1",
    organizationId: "org-1",
    userId: "user-1",
    name: "demo",
    type: "remote",
    config: { type: "remote", url: "https://mcp.example.test" },
    enabled: true,
    createdAt: now,
    updatedAt: now,
    resourceAccess: {
      ownership: "internal",
      writable: true,
      sourceOrganizationId: "org-1",
      resourceUid: "mcp-1",
      resourceKey: "org-1/mcp-1",
      manageable: true,
    },
    ...overrides,
  };
}

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost/api/mcp${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function installEmptyDb() {
  stubDb({ select: () => ({ from: () => ({ where: async () => [] }) }) });
}

function installDefaults() {
  installEmptyDb();
  stubEnvironmentRepo({ getBySecret: async () => null });
  stubConfigPg({
    listMcpServers: async () => [],
    getMcpServerById: async () => null,
    getMcpServer: async () => null,
    createMcpServer: async () => undefined,
    updateMcpServerById: async () => false,
    deleteMcpServerById: async () => false,
  });
}

describe("round47 API MCP 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
    installDefaults();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // 未认证请求必须在进入 MCP 服务前被 session 守卫拒绝。
  test("未认证列表返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });

    expect((await request("/")).status).toBe(401);
  });

  // session 认证必须使用注入的组织上下文，而不是请求中的任意字段。
  test("session 列表将认证组织传给服务", async () => {
    let organizationId = "";
    stubConfigPg({
      listMcpServers: async (ctx) => {
        organizationId = ctx.organizationId;
        return [];
      },
    });

    expect((await request("/")).status).toBe(200);
    expect(organizationId).toBe("org-1");
  });

  // Bearer API key 认证成功后也必须恢复 key 所属组织上下文。
  test("API key 列表将 key 元数据组织传给服务", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    let query = 0;
    let organizationId = "";
    stubAuthApi({
      getSession: async () => null,
      verifyApiKey: async () => ({ valid: true, key: { referenceId: "user-key", organizationId: "org-key" } }),
    });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () =>
              query++ === 0 ? [{ id: "user-key", email: "key@example.test", name: "Key" }] : [{ id: "member-1" }],
          }),
        }),
      }),
    });
    stubConfigPg({
      listMcpServers: async (ctx) => {
        organizationId = ctx.organizationId;
        return [];
      },
    });

    expect((await request("/", { headers: { authorization: "Bearer safe-test-key" } })).status).toBe(200);
    expect(organizationId).toBe("org-key");
  });

  // 无效 API key 不能绕过 session 守卫。
  test("无效 API key 返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });

    expect((await request("/", { headers: { "x-api-key": "invalid" } })).status).toBe(401);
  });

  // 列表必须返回稳定分页结构与总数。
  test("列表返回分页结果", async () => {
    stubConfigPg({ listMcpServers: async () => [server()] });

    const response = await request("/?page=1&pageSize=1");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 1,
      items: [{ id: "mcp-1", name: "demo" }],
    });
  });

  // 分页切片不得把第二页外的资源暴露给调用方。
  test("列表按页码切片", async () => {
    stubConfigPg({
      listMcpServers: async () => [server({ id: "one", name: "one" }), server({ id: "two", name: "two" })],
    });

    const body = await (await request("/?page=2&pageSize=1")).json();

    expect(body).toMatchObject({ total: 2, items: [{ id: "two", name: "two" }] });
  });

  // 工具计数查询失败时不应泄露内部错误或丢弃服务器。
  test("工具计数失败时列表回退为零", async () => {
    stubConfigPg({ listMcpServers: async () => [server()] });
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error("tool database unavailable");
          },
        }),
      }),
    });

    const body = await (await request("/")).json();

    expect(body.items[0]).toMatchObject({ name: "demo", toolsCount: 0, summary: "" });
  });

  // config.type 应优先于旧字段 type，支持 streamable HTTP 响应映射。
  test("列表优先映射 config 中的 streamable-http 类型", async () => {
    stubConfigPg({
      listMcpServers: async () => [
        server({ type: "local", config: { type: "streamable-http", url: "https://stream.example.test" } }),
      ],
    });

    const body = await (await request("/")).json();

    expect(body.items[0]).toMatchObject({ type: "streamable-http", summary: "https://stream.example.test" });
  });

  // 非法分页参数必须在服务调用前被请求 schema 拒绝。
  test("页码小于一返回 422", async () => {
    let called = false;
    stubConfigPg({
      listMcpServers: async () => {
        called = true;
        return [];
      },
    });

    expect((await request("/?page=0")).status).toBe(422);
    expect(called).toBeFalse();
  });

  // 超过上限的 pageSize 必须被 schema 拒绝。
  test("过大的 pageSize 返回 422", async () => {
    expect((await request("/?pageSize=101")).status).toBe(422);
  });

  // 详情读取必须按认证组织上下文和路径 ID 委托服务层。
  test("详情按 ID 查询当前组织资源", async () => {
    let received = "";
    stubConfigPg({
      getMcpServerById: async (ctx, id) => {
        received = `${ctx.organizationId}:${id}`;
        return server();
      },
    });

    expect((await request("/mcp-1")).status).toBe(200);
    expect(received).toBe("org-1:mcp-1");
  });

  // 不存在或无权读取的资源必须统一显示为 404。
  test("详情不存在返回 404", async () => {
    const response = await request("/other-org-resource");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 空路径 ID 必须在服务调用前被路由匹配拒绝。
  test("空 ID 不匹配详情路由", async () => {
    expect((await request("//")).status).toBe(404);
  });

  // 详情应保留共享资源访问属性供客户端进行权限展示。
  test("详情保留共享资源访问描述", async () => {
    stubConfigPg({
      getMcpServerById: async () =>
        server({
          resourceAccess: {
            ownership: "external",
            writable: false,
            sourceOrganizationId: "org-source",
            resourceUid: "mcp-1",
            resourceKey: "org-source/mcp-1",
            manageable: false,
          },
        }),
    });

    const body = await (await request("/shared")).json();

    expect(body.resourceAccess).toMatchObject({ ownership: "external", writable: false });
  });

  // 已存在名称不能创建，避免跨请求覆盖同组织配置。
  test("创建重复名称返回 409", async () => {
    stubConfigPg({ getMcpServer: async () => server() });

    expect((await json("/", "POST", { name: "demo" })).status).toBe(409);
  });

  // 创建远程服务必须将允许字段转换为服务层 config。
  test("创建远程服务映射配置和公开读取", async () => {
    let received: unknown[] = [];
    let lookups = 0;
    stubConfigPg({
      getMcpServer: async (_ctx, name) => {
        lookups += 1;
        return lookups === 2 && name === "new"
          ? server({
              id: "new-id",
              name: "new",
              config: {
                type: "remote",
                url: "https://new.example.test",
                headers: { authorization: "masked" },
                timeout: 3000,
              },
            })
          : null;
      },
      createMcpServer: async (...args) => {
        received = args;
      },
    });

    const response = await json("/", "POST", {
      name: "new",
      type: "remote",
      url: "https://new.example.test",
      headers: { authorization: "masked" },
      timeout: 3000,
      publicReadable: true,
    });

    expect(response.status).toBe(200);
    expect(received.slice(1)).toEqual([
      "new",
      "remote",
      { type: "remote", url: "https://new.example.test", headers: { authorization: "masked" }, timeout: 3000 },
      { publicReadable: true },
    ]);
  });

  // 创建后重载失败必须返回稳定的内部错误，而非伪造成功。
  test("创建后无法重载返回 500", async () => {
    stubConfigPg({ getMcpServer: async () => null, createMcpServer: async () => undefined });

    expect((await json("/", "POST", { name: "new" })).status).toBe(500);
  });

  // 创建请求缺少名称必须被 schema 拒绝且不调用服务。
  test("创建缺少名称返回 422", async () => {
    let called = false;
    stubConfigPg({
      getMcpServer: async () => {
        called = true;
        return null;
      },
    });

    expect((await json("/", "POST", {})).status).toBe(422);
    expect(called).toBeFalse();
  });

  // 更新必须通过 ID 和认证组织调用服务，不能使用请求体重命名。
  test("更新映射本地命令配置", async () => {
    let received: unknown[] = [];
    stubConfigPg({
      updateMcpServerById: async (...args) => {
        received = args;
        return true;
      },
      getMcpServerById: async () => server({ config: { type: "local", command: ["npx", "server"] } }),
    });

    expect(
      (await json("/mcp-1", "PUT", { command: ["npx", "server"], oauth: null, publicReadable: false })).status,
    ).toBe(200);
    expect(received.slice(1)).toEqual([
      "mcp-1",
      { type: "local", command: ["npx", "server"], oauth: false },
      { publicReadable: false },
    ]);
  });

  // 更新不存在资源必须返回 404，防止客户端误以为写入成功。
  test("更新不存在资源返回 404", async () => {
    expect((await json("/missing", "PUT", { enabled: false })).status).toBe(404);
  });

  // 更新后的重载失败必须报告内部错误。
  test("更新后无法重载返回 500", async () => {
    stubConfigPg({ updateMcpServerById: async () => true, getMcpServerById: async () => null });

    expect((await json("/mcp-1", "PUT", { timeout: 1000 })).status).toBe(500);
  });

  // 更新超时为零必须被请求 schema 拒绝。
  test("更新的非法超时返回 422", async () => {
    expect((await json("/mcp-1", "PUT", { timeout: 0 })).status).toBe(422);
  });

  // 删除必须将认证组织与路径 ID 传给服务层。
  test("删除调用当前组织服务并返回确认", async () => {
    let received = "";
    stubConfigPg({
      deleteMcpServerById: async (ctx, id) => {
        received = `${ctx.organizationId}:${id}`;
        return true;
      },
    });

    const response = await request("/mcp-1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ id: "mcp-1", deleted: true });
    expect(received).toBe("org-1:mcp-1");
  });

  // 删除外部或不存在资源必须以 404 隐藏资源存在性。
  test("删除不存在资源返回 404", async () => {
    expect((await request("/other-org-resource", { method: "DELETE" })).status).toBe(404);
  });

  // 业务 AppError 必须保留其对外状态码和错误码。
  test("列表映射业务错误", async () => {
    stubConfigPg({
      listMcpServers: async () => {
        throw new AppError("denied", "FORBIDDEN", 403);
      },
    });

    const response = await request("/");

    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({ error: { code: "FORBIDDEN", message: "denied" } });
  });

  // 未知异常必须映射为 INTERNAL_ERROR，而不能泄露服务层分类。
  test("删除映射未知错误", async () => {
    stubConfigPg({
      deleteMcpServerById: async () => {
        throw new Error("storage failed");
      },
    });

    const response = await request("/mcp-1", { method: "DELETE" });

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({ error: { code: "INTERNAL_ERROR", message: "storage failed" } });
  });
});
