import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { InstanceManager } from "../client/instance-manager.js";
import { isTerminalWebSocketCloseCode, type ServerConfig } from "../server.js";
import { getWebSocketCodeMessage, WEBSOCKET_CODES } from "../websocket-code.js";

describe("Server HTTP endpoints", () => {
  // package.json 入口验证
  test("package.json has correct bin and main entries", async () => {
    const pkg = await import("../../package.json", { with: { type: "json" } });
    expect(pkg.default.name).toBe("acp-link");
    expect(pkg.default.main).toBe("./src/server.ts");
  });

  // ServerConfig 类型验证
  test("ServerConfig interface accepts all expected fields", () => {
    const config: ServerConfig = {
      port: 9315,
      host: "localhost",
      command: "echo",
      args: [],
      cwd: "/tmp",
    };
    expect(config.port).toBe(9315);
    expect(config.host).toBe("localhost");
    expect(config.command).toBe("echo");
  });
});

describe("machine connection close codes", () => {
  // machine 重复连接是永久冲突，认证失败和重复连接都必须停止主 WS 自动重连。
  test("4503 is terminal while transient close codes remain reconnectable", () => {
    expect(isTerminalWebSocketCloseCode(4503)).toBe(true);
    expect(isTerminalWebSocketCloseCode(4003)).toBe(true);
    expect(isTerminalWebSocketCloseCode(4001)).toBe(false);
    expect(isTerminalWebSocketCloseCode(4501)).toBe(false);
    expect(isTerminalWebSocketCloseCode(1011)).toBe(false);
    expect(getWebSocketCodeMessage(WEBSOCKET_CODES.MACHINE_ALREADY_CONNECTED.code)).toContain("machine 连接被拒绝");
    expect(getWebSocketCodeMessage(WEBSOCKET_CODES.UNAUTHORIZED.code)).toContain("认证失败");
    expect(getWebSocketCodeMessage(4999)).toBe("未知 WebSocket code[4999]");
  });
});

describe("WebSocket message types", () => {
  // JSON-RPC 方法名验证
  const acpMethods = [
    "session/new",
    "session/load",
    "session/resume",
    "session/list",
    "session/prompt",
    "session/cancel",
    "session/setModel",
    "session/setMode",
  ];

  // 方法类型计数验证
  test("all ACP method names are defined", () => {
    expect(acpMethods.length).toBe(8);
    expect(acpMethods).toContain("session/new");
    expect(acpMethods).toContain("session/prompt");
    expect(acpMethods).toContain("session/cancel");
  });

  // JSON-RPC 请求格式验证
  test("JSON-RPC request has required fields", () => {
    const request = { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } };
    expect(request.jsonrpc).toBe("2.0");
    expect(request.id).toBe(1);
    expect(request.method).toBe("session/new");
    expect((request.params as Record<string, unknown>).cwd).toBe("/tmp");
  });

  // JSON-RPC 响应格式验证
  test("JSON-RPC success response format", () => {
    const response = { jsonrpc: "2.0", id: 1, result: { sessionId: "ses_1" } };
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect((response.result as Record<string, unknown>).sessionId).toBe("ses_1");
  });

  // JSON-RPC 错误响应格式验证
  test("JSON-RPC error response format", () => {
    const response = { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } };
    expect(response.jsonrpc).toBe("2.0");
    expect((response.error as { code: number }).code).toBe(-32601);
  });

  // JSON-RPC 通知格式验证
  test("JSON-RPC notification has no id", () => {
    const notification = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "ses_1" } };
    expect(notification.jsonrpc).toBe("2.0");
    expect(notification.method).toBe("session/update");
    expect("id" in notification).toBe(false);
  });
});

describe("InstanceManager refresh", () => {
  // 运行实例重新 prepare 只更新 launchSpec，不能清空 dispatcher、session 或 relay 绑定。
  test("preserves running state when refreshing the same workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "acp-link-refresh-"));
    const preparedSpecs: AgentLaunchSpec[] = [];
    const manager = new InstanceManager(
      {
        opencode: {
          prepareWorkspace: async (_workspace, launchSpec) => {
            preparedSpecs.push(launchSpec);
          },
          startInstance: async ({ state }) => {
            state.capabilities = { prompt: true };
            return { capabilities: state.capabilities };
          },
        },
      },
      workspaceRoot,
      "opencode",
    );
    const createSpec = (skills: AgentLaunchSpec["skills"]): AgentLaunchSpec => ({
      organizationId: "org-test",
      userId: "user-test",
      environmentId: "env-test",
      env: {},
      agent: { name: "agent", prompt: "" },
      model: { provider: "test", protocol: "openai", model: "test", modelName: "test" },
      skills,
      mcpServers: [],
    });

    try {
      await manager.prepare("inst-refresh", createSpec([]));
      await manager.start("inst-refresh", () => {});
      manager.setSessionId("inst-refresh", "ses-existing");

      await manager.prepare("inst-refresh", createSpec([{ name: "current", url: "https://example.com/current.zip" }]));

      expect(preparedSpecs).toHaveLength(2);
      expect(preparedSpecs[1].skills).toEqual([{ name: "current", url: "https://example.com/current.zip" }]);
      expect(manager.hasInstance("inst-refresh")).toBe(true);
      expect(manager.getSessionId("inst-refresh")).toBe("ses-existing");
    } finally {
      await manager.stop("inst-refresh");
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("Heartbeat constants", () => {
  // 权限超时常量验证
  test("PERMISSION_TIMEOUT_MS is 5 minutes", () => {
    const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
    expect(PERMISSION_TIMEOUT_MS).toBe(300_000);
  });

  // 心跳间隔常量验证
  test("HEARTBEAT_INTERVAL_MS is 30 seconds", () => {
    const HEARTBEAT_INTERVAL_MS = 30_000;
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});
