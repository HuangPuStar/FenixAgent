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
    const { mcpApi } = await import("../api/sdk");
    const { data, error } = await mcpApi.list();
    expect(error).toBeUndefined();
    const result = data as any;
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].id).toBe("mcp_1");
    expect(result.servers[0].name).toBe("my-local");
    expect("resourceKey" in result.servers[0]).toBe(false);
  });

  // 测试 MCP 列表发送正确请求
  test("mcpApi.list sends correct payload", async () => {
    fetchMock.body = { success: true, data: { servers: [] } };
    const { mcpApi } = await import("../api/sdk");
    await mcpApi.list();
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("list");
  });

  // 测试获取 MCP 服务器详情正常返回
  test("mcpApi.get returns server detail", async () => {
    fetchMock.body = {
      success: true,
      data: { name: "my-local", config: { type: "local", command: ["npx", "mcp-server"] } },
    };
    const { mcpApi } = await import("../api/sdk");
    const { data, error } = await mcpApi.get("my-local");
    expect(error).toBeUndefined();
    const result = data as any;
    expect(result.config.type).toBe("local");
  });

  // 测试获取 MCP 服务器发送正确 payload
  test("mcpApi.get sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "test", config: { type: "local", command: ["npx"] } } };
    const { mcpApi } = await import("../api/sdk");
    await mcpApi.get("test-server");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("get");
    expect(body.name).toBe("test-server");
  });

  // 测试创建 MCP 服务器正常返回
  test("mcpApi.create returns server info", async () => {
    fetchMock.body = { success: true, data: { name: "new-server" } };
    const { mcpApi } = await import("../api/sdk");
    const { data, error } = await mcpApi.create("new-server", { type: "local", command: ["npx"] });
    expect(error).toBeUndefined();
    expect((data as any).name).toBe("new-server");
  });

  // 测试创建 MCP 服务器发送正确 payload
  test("mcpApi.create sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "new-server" } };
    const { mcpApi } = await import("../api/sdk");
    const config = { type: "local" as const, command: ["npx", "mcp-server"] };
    await mcpApi.create("new-server", config);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("create");
    expect(body.name).toBe("new-server");
    expect(body.data.type).toBe("local");
  });

  // 测试更新 MCP 服务器发送正确 payload
  test("mcpApi.set sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "my-local" } };
    const { mcpApi } = await import("../api/sdk");
    const config = { type: "local" as const, command: ["npx", "updated"] };
    await mcpApi.set("my-local", config);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("set");
    expect(body.name).toBe("my-local");
    expect(body.data.command).toEqual(["npx", "updated"]);
  });

  // 测试删除 MCP 服务器发送 delete action
  test("mcpApi.delete sends delete action", async () => {
    fetchMock.body = { success: true, data: null };
    const { mcpApi } = await import("../api/sdk");
    await mcpApi.delete("test-srv");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("delete");
    expect(body.name).toBe("test-srv");
  });

  // 测试启用 MCP 服务器正常返回
  test("mcpApi.enable returns enabled server", async () => {
    fetchMock.body = { success: true, data: { name: "s1", enabled: true } };
    const { mcpApi } = await import("../api/sdk");
    const { data, error } = await mcpApi.enable("s1");
    expect(error).toBeUndefined();
    expect((data as any).enabled).toBe(true);
  });

  // 测试禁用 MCP 服务器正常返回
  test("mcpApi.disable returns disabled server", async () => {
    fetchMock.body = { success: true, data: { name: "s1", enabled: false } };
    const { mcpApi } = await import("../api/sdk");
    const { data, error } = await mcpApi.disable("s1");
    expect(error).toBeUndefined();
    expect((data as any).enabled).toBe(false);
  });

  // 测试错误响应返回 error
  test("error response returns error", async () => {
    fetchMock.status = 404;
    fetchMock.body = { success: false, error: { code: "NOT_FOUND", message: "Server not found" } };
    const { mcpApi } = await import("../api/sdk");
    const { error } = await mcpApi.get("xxx");
    expect(error).not.toBeNull();
  });
});
