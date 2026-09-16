import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock fetch
const fetchMock = { status: 200, body: {} as unknown };

beforeEach(() => {
  fetchMock.status = 200;
  fetchMock.body = {};
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(fetchMock.body), {
        status: fetchMock.status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
});

describe("MCP SDK module", () => {
  // 测试 MCP 服务器列表正常返回
  test("mcpApi.list returns servers", async () => {
    fetchMock.body = {
      success: true,
      data: { servers: [{ id: "mcp_1", name: "my-local", type: "local", enabled: true, summary: "npx" }] },
    };
    const { mcpApi } = await import("../api/mcp");
    const { data, error } = await mcpApi.list();
    expect(error).toBeUndefined();
    const result = data as any;
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].id).toBe("mcp_1");
    expect(result.servers[0].name).toBe("my-local");
    expect("resourceKey" in result.servers[0]).toBe(false);
  });

  // 测试 MCP 列表发送正确请求 (GET 无 body)
  test("mcpApi.list sends correct payload", async () => {
    fetchMock.body = { success: true, data: { servers: [] } };
    const { mcpApi } = await import("../api/mcp");
    await mcpApi.list();
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(url).toBe("/web/config/mcp");
    // GET 请求不应该有 body
    expect(init.body).toBeUndefined();
  });

  // 测试获取 MCP 服务器详情正常返回
  test("mcpApi.get returns server detail", async () => {
    fetchMock.body = {
      success: true,
      data: { name: "my-local", config: { type: "local", command: ["npx", "mcp-server"] } },
    };
    const { mcpApi } = await import("../api/mcp");
    const { data, error } = await mcpApi.get("my-local");
    expect(error).toBeUndefined();
    const result = data as any;
    expect(result.config.type).toBe("local");
  });

  // 测试获取 MCP 服务器发送正确请求 (GET + query 参数)
  test("mcpApi.get sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "test", config: { type: "local", command: ["npx"] } } };
    const { mcpApi } = await import("../api/mcp");
    await mcpApi.get("test-server");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(url).toContain("/web/config/mcp?");
    expect(url).toContain("name=test-server");
  });

  // 测试创建 MCP 服务器正常返回
  test("mcpApi.create returns server info", async () => {
    fetchMock.body = { success: true, data: { name: "new-server" } };
    const { mcpApi } = await import("../api/mcp");
    const { data, error } = await mcpApi.create("new-server", { type: "local", command: ["npx"] });
    expect(error).toBeUndefined();
    expect((data as any).name).toBe("new-server");
  });

  // 测试创建 MCP 服务器发送正确请求 (POST + body: { name, config })
  test("mcpApi.create sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "new-server" } };
    const { mcpApi } = await import("../api/mcp");
    const config = { type: "local" as const, command: ["npx", "mcp-server"] };
    await mcpApi.create("new-server", config);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(init.method).toBe("POST");
    expect(body.name).toBe("new-server");
    expect(body.config.type).toBe("local");
    // 新 REST 风格不包含 action 字段
    expect(body.action).toBeUndefined();
  });

  // 测试更新 MCP 服务器发送正确请求 (PUT + query + body: { config })
  test("mcpApi.update sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "my-local" } };
    const { mcpApi } = await import("../api/mcp");
    const config = { type: "local" as const, command: ["npx", "updated"] };
    await mcpApi.update("my-local", config);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(init.method).toBe("PUT");
    expect(url).toContain("name=my-local");
    expect(body.config.command).toEqual(["npx", "updated"]);
  });

  // 测试删除 MCP 服务器发送 DELETE 请求
  test("mcpApi.del sends delete action", async () => {
    fetchMock.body = { success: true, data: null };
    const { mcpApi } = await import("../api/mcp");
    await mcpApi.del("test-srv");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const url = call[0] as string;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(url).toContain("name=test-srv");
  });

  // 测试启用 MCP 服务器正常返回
  test("mcpApi.enable returns enabled server", async () => {
    fetchMock.body = { success: true, data: { name: "s1", enabled: true } };
    const { mcpApi } = await import("../api/mcp");
    const { data, error } = await mcpApi.enable("s1");
    expect(error).toBeUndefined();
    expect((data as any).enabled).toBe(true);
  });

  // 测试禁用 MCP 服务器正常返回
  test("mcpApi.disable returns disabled server", async () => {
    fetchMock.body = { success: true, data: { name: "s1", enabled: false } };
    const { mcpApi } = await import("../api/mcp");
    const { data, error } = await mcpApi.disable("s1");
    expect(error).toBeUndefined();
    expect((data as any).enabled).toBe(false);
  });

  // 测试错误响应返回 error
  test("error response returns error", async () => {
    fetchMock.status = 404;
    fetchMock.body = { success: false, error: { code: "NOT_FOUND", message: "Server not found" } };
    const { mcpApi } = await import("../api/mcp");
    const { error } = await mcpApi.get("xxx");
    expect(error).not.toBeNull();
  });
});
