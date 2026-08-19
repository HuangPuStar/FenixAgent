import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const mcpRoute = (await import("../routes/web/config/mcp")).default;

const now = new Date("2026-08-19T00:00:00.000Z");

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
}

function request(path: string, init?: RequestInit) {
  return mcpRoute.handle(new Request(`http://localhost${path}`, init));
}

function jsonRequest(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function server(overrides: Record<string, unknown> = {}) {
  return {
    id: "mcp-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "demo",
    type: "remote",
    config: { type: "remote", url: "https://mcp.example.test" },
    enabled: true,
    createdAt: now,
    updatedAt: now,
    resourceAccess: {
      ownership: "internal",
      sourceOrganizationId: "org-1",
      resourceUid: "mcp-1",
      resourceKey: "org-1/mcp-1",
      manageable: true,
      writable: true,
    },
    ...overrides,
  };
}

function stubEmptyToolDb() {
  stubDb({
    select: () => ({ from: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => undefined }),
  });
}

describe("round40 MCP 配置路由", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
    stubEmptyToolDb();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 认证上下文的组织 ID 必须原样传给列表服务，确保组织隔离由服务层执行。
  test("列表将认证组织传递给服务层", async () => {
    let organizationId = "";
    stubConfigPg({
      listMcpServers: async (ctx) => {
        organizationId = ctx.organizationId;
        return [];
      },
    });

    const response = await request("/config/mcp");

    expect(response.status).toBe(200);
    expect(organizationId).toBe("org-1");
  });

  // 空列表不应触发工具计数查询，也应保持成功响应形状。
  test("列表返回当前组织的空服务器集合", async () => {
    stubConfigPg({ listMcpServers: async () => [] });

    const response = await request("/config/mcp");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { servers: [] } });
  });

  // 工具计数查询失败时，列表仍应返回服务器并将数量降为零。
  test("列表在工具计数失败时回退为零", async () => {
    stubConfigPg({ listMcpServers: async () => [server()] });
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error("db unavailable");
          },
        }),
      }),
    });

    const response = await request("/config/mcp");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.servers[0]).toMatchObject({ name: "demo", toolsCount: 0, resourceAccess: { writable: true } });
  });

  // 普通名称详情查询必须委托当前组织范围内的读取接口。
  test("详情按普通名称读取内部服务器", async () => {
    let receivedName = "";
    stubConfigPg({
      getMcpServer: async (_ctx, name) => {
        receivedName = name;
        return server();
      },
    });

    const response = await request("/config/mcp?name=demo");

    expect(response.status).toBe(200);
    expect(receivedName).toBe("demo");
    expect((await response.json()).data.config).toEqual({ type: "remote", url: "https://mcp.example.test" });
  });

  // resource key 必须走共享资源读取接口而不是同名内部资源接口。
  test("详情按 resource key 读取外部服务器", async () => {
    let receivedKey = "";
    stubConfigPg({
      getMcpServerByResourceKey: async (_ctx, key) => {
        receivedKey = key;
        return server({ organizationId: "org-2", resourceAccess: { ownership: "external", writable: false } });
      },
    });

    const response = await request("/config/mcp?name=org-2/mcp-shared");

    expect(response.status).toBe(200);
    expect(receivedKey).toBe("org-2/mcp-shared");
    expect((await response.json()).data.resourceAccess).toEqual({ ownership: "external", writable: false });
  });

  // 找不到的详情应映射为标准 404 业务错误。
  test("详情不存在时返回 404", async () => {
    stubConfigPg({ getMcpServer: async () => null });

    const response = await request("/config/mcp?name=missing");

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 创建名称不符合约束时不得调用持久化服务。
  test("创建拒绝非法服务器名称", async () => {
    let created = false;
    stubConfigPg({
      createMcpServer: async () => {
        created = true;
      },
    });

    const response = await jsonRequest("/config/mcp", "POST", {
      name: "Invalid_Name",
      config: { type: "remote", url: "https://mcp.example.test" },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(created).toBe(false);
  });

  // 创建必须校验配置类型和必要字段。
  test("创建拒绝缺失 URL 的远程配置", async () => {
    stubConfigPg({ getMcpServer: async () => null });

    const response = await jsonRequest("/config/mcp", "POST", { name: "demo", config: { type: "remote" } });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("INVALID_URL");
  });

  // 内部同名服务器冲突应保留为 409。
  test("创建内部同名服务器返回 409", async () => {
    stubConfigPg({ getMcpServer: async () => server() });

    const response = await jsonRequest("/config/mcp", "POST", {
      name: "demo",
      config: { type: "remote", url: "https://mcp.example.test" },
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ALREADY_EXISTS");
  });

  // 创建应剥离配置中的共享标志，并把请求体标志优先传给服务层。
  test("创建透传请求体 publicReadable 并保留远程类型", async () => {
    let captured: unknown[] = [];
    stubConfigPg({
      getMcpServer: async () => null,
      createMcpServer: async (...args) => {
        captured = args;
      },
    });

    const response = await jsonRequest("/config/mcp", "POST", {
      name: "demo",
      publicReadable: false,
      config: { type: "remote", url: "https://mcp.example.test", publicReadable: true },
    });

    expect(response.status).toBe(200);
    expect(captured.slice(1)).toEqual([
      "demo",
      "remote",
      { type: "remote", url: "https://mcp.example.test" },
      { publicReadable: false },
    ]);
  });

  // 更新没有 name 查询参数时应在业务服务调用前失败。
  test("更新缺少名称返回 400", async () => {
    const response = await jsonRequest("/config/mcp", "PUT", { type: "remote", url: "https://mcp.example.test" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("缺少 'name' 查询参数");
  });

  // 更新同样使用配置验证，避免非法本地命令落库。
  test("更新拒绝空本地命令", async () => {
    const response = await jsonRequest("/config/mcp?name=demo", "PUT", { type: "local", command: [] });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("INVALID_COMMAND");
  });

  // 更新目标不存在时返回 404，不能静默成功。
  test("更新不存在服务器返回 404", async () => {
    stubConfigPg({ getMcpServer: async () => null });

    const response = await jsonRequest("/config/mcp?name=missing", "PUT", {
      type: "remote",
      url: "https://mcp.example.test",
    });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 更新应移除嵌入配置的共享标志，防止其进入服务器配置。
  test("更新剥离配置内 publicReadable", async () => {
    let captured: unknown[] = [];
    stubConfigPg({
      getMcpServer: async () => server(),
      updateMcpServer: async (...args) => {
        captured = args;
        return true;
      },
    });

    const response = await jsonRequest("/config/mcp?name=demo", "PUT", {
      type: "remote",
      url: "https://next.example.test",
      publicReadable: true,
    });

    expect(response.status).toBe(200);
    expect(captured.slice(1)).toEqual([
      "demo",
      { type: "remote", url: "https://next.example.test" },
      { publicReadable: true },
    ]);
  });

  // 删除缺少名称时必须返回参数校验错误。
  test("删除缺少名称返回 400", async () => {
    const response = await request("/config/mcp", { method: "DELETE" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  // 删除不可写或不属于当前组织的资源时，服务层抛出的权限错误应保留 403。
  test("删除外部共享服务器返回 403", async () => {
    stubConfigPg({
      assertMcpServerInternalWritable: async () => {
        throw new AppError("read only", "FORBIDDEN", 403);
      },
    });

    const response = await request("/config/mcp?name=org-2/mcp-shared", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual({ code: "FORBIDDEN", message: "read only" });
  });

  // 删除前的写权限查询未命中时应返回 404。
  test("删除权限查询未命中时返回 404", async () => {
    stubConfigPg({ assertMcpServerInternalWritable: async () => null });

    const response = await request("/config/mcp?name=missing", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 主记录删除失败时不应执行工具清理，也应返回 404。
  test("删除主记录失败时返回 404", async () => {
    stubConfigPg({
      assertMcpServerInternalWritable: async () => server(),
      deleteMcpServer: async () => false,
    });

    const response = await request("/config/mcp?name=demo", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 工具清理异常是 best-effort，不应回滚成功删除响应。
  test("删除在工具清理失败时仍成功", async () => {
    stubConfigPg({
      assertMcpServerInternalWritable: async () => server(),
      deleteMcpServer: async () => true,
    });
    stubDb({
      delete: () => ({
        where: async () => {
          throw new Error("cleanup failure");
        },
      }),
    });

    const response = await request("/config/mcp?name=demo", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
  });

  // 启用历史损坏配置必须提示重建，而不能写入 enabled 状态。
  test("启用缺失类型的配置返回校验错误", async () => {
    stubConfigPg({ assertMcpServerInternalWritable: async () => server({ config: {} }) });

    const response = await jsonRequest("/config/mcp/actions/enable?name=demo", "POST");

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("original config lost");
  });

  // 启用内部服务器应将 true 传递给组织范围服务。
  test("启用内部服务器写入 enabled true", async () => {
    let captured: unknown[] = [];
    stubConfigPg({
      assertMcpServerInternalWritable: async () => server(),
      setMcpServerEnabled: async (...args) => {
        captured = args;
      },
    });

    const response = await jsonRequest("/config/mcp/actions/enable?name=demo", "POST");

    expect(response.status).toBe(200);
    expect(captured.slice(1)).toEqual(["demo", true]);
  });

  // 禁用内部服务器应将 false 传递给组织范围服务。
  test("禁用内部服务器写入 enabled false", async () => {
    let captured: unknown[] = [];
    stubConfigPg({
      assertMcpServerInternalWritable: async () => server(),
      setMcpServerEnabled: async (...args) => {
        captured = args;
      },
    });

    const response = await jsonRequest("/config/mcp/actions/disable?name=demo", "POST");

    expect(response.status).toBe(200);
    expect(captured.slice(1)).toEqual(["demo", false]);
  });

  // 任意 URL 检测在 URL 缺失时必须短路，避免发起网络请求。
  test("检测 URL 缺失时返回 400", async () => {
    const response = await jsonRequest("/config/mcp/actions/test-url", "POST", {});

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("URL is required");
  });

  // inspect 仅支持 remote，其他类型应在探测前被拒绝。
  test("检测本地服务器工具时返回 400", async () => {
    stubConfigPg({
      assertMcpServerInternalWritable: async () =>
        server({ type: "local", config: { type: "local", command: ["node"] } }),
    });

    const response = await jsonRequest("/config/mcp/actions/inspect?name=demo", "POST");

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe("Inspect only supports remote MCP servers");
  });

  // 缓存工具列表应允许按授权 resource key 查询并序列化时间戳。
  test("外部服务器工具列表按 resource key 返回", async () => {
    stubConfigPg({
      getMcpServerByResourceKey: async () => server({ organizationId: "org-2" }),
    });
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: "tool-1",
              toolName: "search",
              description: "Search documents",
              inputSchema: { type: "object" },
              inspectedAt: now,
            },
          ],
        }),
      }),
    });

    const response = await request("/config/mcp/actions/tools?name=org-2/mcp-shared");

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      name: "org-2/mcp-shared",
      tools: [
        {
          id: "tool-1",
          toolName: "search",
          description: "Search documents",
          inputSchema: { type: "object" },
          inspectedAt: now.getTime(),
        },
      ],
    });
  });

  // 缓存工具列表缺少服务器时应映射为 404。
  test("工具列表服务器不存在时返回 404", async () => {
    stubConfigPg({ getMcpServer: async () => null });

    const response = await request("/config/mcp/actions/tools?name=missing");

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });
});
