import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NotFoundError } from "@fenix/platform-sdk";
import { readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { resetTestAuth, setTestAuth } from "@server/plugins/auth";
import { setTestOrgContext } from "@server/services/org-context";
import * as mcpInspector from "../server/services/mcp-inspector";
import { authorizedServer, installMcpModuleStub, resetMcpModuleStub } from "./fixtures";

/**
 * MCP 配置路由的连接检测用例。
 *
 * 探测本身（MCP 协议握手 / 本地命令可用性）留在协议层，权限与资源解析在 Facade：可写资源的获取
 * 失败（404/403）必须在探测之前终止，避免对无权访问的地址发起出网请求。
 */

const mcpRoute = (await import("../server/routes/web/config/mcp")).default;

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

describe("MCP 配置路由补充覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    resetMcpModuleStub();
    authenticate();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetMcpModuleStub();
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

  // 不可见或不存在时不得进入远程探测：探测会向地址发起出网请求。
  test("测试不存在的服务器返回 404", async () => {
    let inspected = false;
    const inspect = spyOn(mcpInspector, "inspectRemoteMcpServer").mockImplementation(async () => {
      inspected = true;
      return { reachable: true, protocol: true, tools: [] };
    });
    installMcpModuleStub({
      facade: {
        getWritable: async () => {
          throw new NotFoundError("MCP server 'missing' not found");
        },
      },
    });

    const response = await request("/config/mcp/actions/test?name=missing", { method: "POST" });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "MCP server 'missing' not found" },
    });
    expect(inspected).toBeFalse();
    inspect.mockRestore();
  });

  // 保存了未知配置类型的资源不得被误当成可执行的本地或远程服务器。
  test("测试未知配置类型返回校验错误", async () => {
    installMcpModuleStub({
      facade: { getWritable: async () => authorizedServer({ name: "remote-server", config: { type: "legacy" } }) },
    });

    const response = await request("/config/mcp/actions/test?name=remote-server", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Cannot test 'remote-server': unsupported config type" },
    });
  });

  // 远程探测不可达时映射为稳定响应，并透传组织内保存的超时与认证头。
  test("远程服务器不可达时返回连接失败且使用保存配置", async () => {
    const inspect = spyOn(mcpInspector, "inspectRemoteMcpServer").mockResolvedValue({
      reachable: false,
      protocol: false,
      tools: [],
    });
    installMcpModuleStub({
      facade: {
        getWritable: async () =>
          authorizedServer({
            name: "remote-server",
            config: {
              type: "remote",
              url: "https://mcp.example.test/endpoint",
              headers: { "x-organization": "org-1" },
              timeout: 2500,
              oauth: { clientId: "test-client-id" },
            },
          }),
      },
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

  // 任意 URL 探测缺少 url 时必须返回校验错误，不得把 undefined 传给探测器。
  test("任意 URL 缺少地址返回校验错误", async () => {
    const response = await request("/config/mcp/actions/test-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "URL is required" },
    });
  });

  // 检测工具只对 remote 类型开放：local 服务器的工具清单随进程启动检测，不在此路径。
  test("检测本地服务器返回校验错误", async () => {
    installMcpModuleStub({
      facade: {
        getWritable: async () =>
          authorizedServer({ name: "local-server", config: { type: "local", command: ["npx", "server"] } }),
      },
    });

    const response = await request("/config/mcp/actions/inspect?name=local-server", { method: "POST" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Inspect only supports remote MCP servers" },
    });
  });

  // 探测失败时不得写入候选工具，避免把一次失败握手的结果当作已检测清单。
  test("检测不可达时返回校验错误且不写入工具", async () => {
    const inspect = spyOn(mcpInspector, "inspectRemoteMcpServer").mockResolvedValue({
      reachable: false,
      protocol: false,
      tools: [],
      message: "无法连接到 MCP 服务器",
    });
    let saved = false;
    installMcpModuleStub({
      facade: {
        getWritable: async () =>
          authorizedServer({ name: "remote-server", config: { type: "remote", url: "https://mcp.example.test" } }),
        saveInspectedTools: async () => {
          saved = true;
          return "remote-server";
        },
      },
    });

    const response = await request("/config/mcp/actions/inspect?name=remote-server", { method: "POST" });

    expect(response.status).toBe(400);
    expect(saved).toBeFalse();
    inspect.mockRestore();
  });

  // 检测成功时写入候选工具，并以资源自身名称回包（资源键与名称不是同一个标识）。
  test("检测成功写入工具并返回资源自身名称", async () => {
    const inspect = spyOn(mcpInspector, "inspectRemoteMcpServer").mockResolvedValue({
      reachable: true,
      protocol: true,
      serverName: "安全工具服务",
      serverVersion: "1.2.3",
      transport: "streamable-http",
      tools: [{ name: "审计", description: "读取审计日志", inputSchema: { type: "object" } }],
    });
    let savedTools: readonly { name: string }[] = [];
    installMcpModuleStub({
      facade: {
        getWritable: async () =>
          authorizedServer({
            id: "mcp-external",
            name: "shared",
            organizationId: "org-source",
            config: { type: "remote", url: "https://mcp.example.test" },
          }),
        saveInspectedTools: async (_actor, _nameOrKey, tools) => {
          savedTools = tools;
          return "shared";
        },
      },
    });

    const response = await request("/config/mcp/actions/inspect?name=org-source/mcp-external", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: {
        name: "shared",
        serverInfo: { name: "安全工具服务", version: "1.2.3" },
        tools: [{ name: "审计", description: "读取审计日志", inputSchema: { type: "object" } }],
        transport: "streamable-http",
        stored: true,
      },
    });
    expect(savedTools).toEqual([{ name: "审计", description: "读取审计日志", inputSchema: { type: "object" } }]);
    inspect.mockRestore();
  });
});
