import { describe, expect, test } from "bun:test";

// ── mcp-server updateMcpServer type 验证 + provider/user-config onConflictDoUpdate ──

// 直接测试 validateMcpConfig 和 VALID_MCP_TYPES 的行为（纯函数）
// onConflictDoUpdate 的原子性通过代码审查 + TypeScript 类型保证，集成测试需要 DB

// validateMcpConfig 是纯函数，直接 import
const { validateMcpConfig, isValidMcpName } = await import("../services/config/mcp-server");

describe("mcp-server updateMcpServer type validation", () => {
  // streamable-http 类型被 validateMcpConfig 接受
  test("validateMcpConfig accepts streamable-http type", () => {
    const result = validateMcpConfig({
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
      enabled: true,
    });
    expect(result).toBeNull();
  });

  // local 类型被接受
  test("validateMcpConfig accepts local type", () => {
    const result = validateMcpConfig({
      type: "local",
      command: ["npx", "server-github"],
      enabled: true,
    });
    expect(result).toBeNull();
  });

  // remote 类型被接受
  test("validateMcpConfig accepts remote type", () => {
    const result = validateMcpConfig({
      type: "remote",
      url: "https://mcp.example.com/sse",
      enabled: true,
    });
    expect(result).toBeNull();
  });

  // 无效类型被拒绝
  test("validateMcpConfig rejects unknown type", () => {
    const result = validateMcpConfig({
      type: "foo-bar",
      url: "https://example.com",
      enabled: true,
    });
    expect(result).toBe("INVALID_CONFIG_TYPE");
  });

  // 仅 enabled:false 且无其他字段时通过（快速禁用路径）
  test("validateMcpConfig allows enabled-only config", () => {
    const result = validateMcpConfig({ enabled: false });
    expect(result).toBeNull();
  });
});

describe("mcp-server isValidMcpName", () => {
  // 合法名称
  test("accepts valid kebab-case names", () => {
    expect(isValidMcpName("my-server")).toBe(true);
    expect(isValidMcpName("a")).toBe(true);
    expect(isValidMcpName("server123")).toBe(true);
  });

  // 拒绝无效名称
  test("rejects invalid names", () => {
    expect(isValidMcpName("")).toBe(false);
    expect(isValidMcpName("My-Server")).toBe(false);
    expect(isValidMcpName("-server")).toBe(false);
    expect(isValidMcpName("server-")).toBe(false);
    expect(isValidMcpName("a--b")).toBe(false);
  });
});
