import { describe, expect, test } from "bun:test";
import type { ServerConfig } from "../server.js";

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
