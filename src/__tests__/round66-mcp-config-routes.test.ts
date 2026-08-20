import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import * as mcpInspector from "../services/mcp-inspector";
import { setTestOrgContext } from "../services/org-context";
import { readJson, resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const mcpRoute = (await import("../routes/web/config/mcp")).default;

function authenticate() {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
}

function request(path: string, init?: RequestInit) {
  return mcpRoute.handle(new Request(`http://localhost${path}`, init));
}

function remoteServer(config: Record<string, unknown>) {
  return {
    id: "mcp-1",
    organizationId: "org-1",
    name: "remote-server",
    config,
  };
}

describe("MCP 配置路由补充覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // 测试已保存服务器时缺少名称必须在访问组织资源前被拒绝。
  test("测试动作缺少名称返回参数校验错误", async () => {
    const response = await request("/config/mcp/actions/test", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "缺少 'name' 查询参数" },
    });
  });

  // 当前组织未找到服务器时，不得进入远程探测或本地命令检查。
  test("测试不存在的服务器返回 404", async () => {
    stubConfigPg({ assertMcpServerInternalWritable: async () => null });

    const response = await request("/config/mcp/actions/test?name=missing", { method: "POST" });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "MCP server 'missing' not found" },
    });
  });

  // 保存了未知配置类型的资源不得被误当成可执行的本地或远程服务器。
  test("测试未知配置类型返回校验错误", async () => {
    stubConfigPg({
      assertMcpServerInternalWritable: async () => remoteServer({ type: "legacy" }),
    });

    const response = await request("/config/mcp/actions/test?name=remote-server", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Cannot test 'remote-server': unsupported config type" },
    });
  });

  // 远程探测不可达时必须映射为稳定响应，并透传组织内保存的超时与认证头。
  test("远程服务器不可达时返回连接失败且使用保存配置", async () => {
    const inspect = spyOn(mcpInspector, "inspectRemoteMcpServer").mockResolvedValue({
      reachable: false,
      protocol: false,
      tools: [],
    });
    stubConfigPg({
      assertMcpServerInternalWritable: async () =>
        remoteServer({
          type: "remote",
          url: "https://mcp.example.test/endpoint",
          headers: { "x-organization": "org-1" },
          timeout: 2500,
          oauth: { clientId: "test-client-id" },
        }),
    });

    const response = await request("/config/mcp/actions/test?name=remote-server", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: { name: "remote-server", reachable: false, protocol: false, message: "连接失败" },
    });
    expect(inspect).toHaveBeenCalledWith(
      "https://mcp.example.test/endpoint",
      { "x-organization": "org-1", Authorization: "Bearer test-client-id" },
      2500,
    );
    inspect.mockRestore();
  });

  // URL 探测到可达但非 MCP 协议的端点时，应保留诊断信息而不是伪报连接失败。
  test("任意 URL 非 MCP 协议时返回探测诊断", async () => {
    const inspect = spyOn(mcpInspector, "inspectRemoteMcpServer").mockResolvedValue({
      reachable: true,
      protocol: false,
      tools: [],
      message: "HTTP endpoint only",
    });

    const response = await request("/config/mcp/actions/test-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://mcp.example.test/endpoint", timeout: 125 }),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: { reachable: true, protocol: false, message: "HTTP endpoint only" },
    });
    expect(inspect).toHaveBeenCalledWith("https://mcp.example.test/endpoint", undefined, 125);
    inspect.mockRestore();
  });
});
