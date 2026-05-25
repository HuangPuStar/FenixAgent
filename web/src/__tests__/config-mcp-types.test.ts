import { describe, expect, test } from "bun:test";
import type {
  McpLocalConfig,
  McpRemoteConfig,
  McpServerConfig,
  McpServerDetail,
  McpServerInfo,
  OpenCodeConfig,
} from "../types/config";

describe("MCP 类型定义", () => {
  test("McpLocalConfig 基本构造", () => {
    const config: McpLocalConfig = { type: "local", command: ["npx", "mcp-server"] };
    expect(config.type).toBe("local");
    expect(config.command).toHaveLength(2);
    expect(config.command[0]).toBe("npx");
  });

  test("McpLocalConfig 含可选字段", () => {
    const config: McpLocalConfig = {
      type: "local",
      command: ["npx", "mcp-server"],
      environment: { KEY: "VALUE" },
      enabled: true,
      timeout: 5000,
    };
    expect(config.environment).toEqual({ KEY: "VALUE" });
    expect(config.enabled).toBe(true);
    expect(config.timeout).toBe(5000);
  });

  test("McpRemoteConfig 基本构造", () => {
    const config: McpRemoteConfig = { type: "remote", url: "https://example.com/mcp" };
    expect(config.type).toBe("remote");
    expect(config.url).toBe("https://example.com/mcp");
  });

  test("McpRemoteConfig 含 headers 和 oauth", () => {
    const config: McpRemoteConfig = {
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Auth: "Bearer t" },
      oauth: { clientId: "x" },
    };
    expect(config.headers).toEqual({ Auth: "Bearer t" });
    expect(config.oauth && typeof config.oauth === "object" && config.oauth.clientId).toBe("x");
  });

  test("McpRemoteConfig oauth 为 false", () => {
    const config: McpRemoteConfig = { type: "remote", url: "https://example.com/mcp", oauth: false };
    expect(config.oauth).toBe(false);
  });

  test("McpServerConfig 禁用变体", () => {
    const config: McpServerConfig = { enabled: false };
    expect("enabled" in config).toBe(true);
    expect(config.enabled).toBe(false);
    expect(!("type" in config)).toBe(true);
  });

  test("McpServerInfo 列表项构造", () => {
    const info: McpServerInfo = { name: "test", type: "local", enabled: true, summary: "npx" };
    expect(info.name).toBe("test");
    expect(info.type).toBe("local");
    expect(info.enabled).toBe(true);
    expect(info.summary).toBe("npx");
  });

  test("McpServerDetail 编辑项构造", () => {
    const detail: McpServerDetail = { name: "test", config: { type: "local", command: ["npx"] } };
    expect(detail.name).toBe("test");
    expect("type" in detail.config && detail.config.type).toBe("local");
  });

  test("OpenCodeConfig 包含 mcp 字段", () => {
    const config: OpenCodeConfig = {
      mcp: { server1: { type: "local", command: ["npx"] } },
    };
    expect(config.mcp).toBeDefined();
    expect("server1" in (config.mcp as Record<string, unknown>)).toBe(true);
  });
});
