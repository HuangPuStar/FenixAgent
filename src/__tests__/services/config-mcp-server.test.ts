import { describe, expect, test } from "bun:test";
import { isValidMcpName, toServerInfo, validateMcpConfig } from "../../services/config/mcp-server";

describe("validateMcpConfig", () => {
  // local 有效配置
  test("local 有效配置", () => {
    expect(validateMcpConfig({ type: "local", command: ["npx", "server"] })).toBeNull();
  });

  // local 缺少 command
  test("local 缺少 command", () => {
    expect(validateMcpConfig({ type: "local" })).toBe("INVALID_COMMAND");
  });

  // local command 为空数组
  test("local command 为空数组", () => {
    expect(validateMcpConfig({ type: "local", command: [] })).toBe("INVALID_COMMAND");
  });

  // remote 有效配置
  test("remote 有效配置", () => {
    expect(validateMcpConfig({ type: "remote", url: "https://example.com" })).toBeNull();
  });

  // remote 缺少 url
  test("remote 缺少 url", () => {
    expect(validateMcpConfig({ type: "remote" })).toBe("INVALID_URL");
  });

  // 缺少 type
  test("缺少 type", () => {
    expect(validateMcpConfig({ command: ["npx"] })).toBe("INVALID_CONFIG_TYPE");
  });

  // disabled 变体
  test("disabled 变体", () => {
    expect(validateMcpConfig({ enabled: false })).toBeNull();
  });

  // null 输入
  test("null 输入", () => {
    expect(validateMcpConfig(null)).toBe("INVALID_CONFIG");
  });

  // local 无效 environment
  test("local 无效 environment", () => {
    expect(validateMcpConfig({ type: "local", command: ["npx"], environment: "bad" })).toBe("INVALID_ENVIRONMENT");
  });

  // local 无效 timeout
  test("local 无效 timeout", () => {
    expect(validateMcpConfig({ type: "local", command: ["npx"], timeout: -1 })).toBe("INVALID_TIMEOUT");
  });

  // remote 无效 headers
  test("remote 无效 headers", () => {
    expect(validateMcpConfig({ type: "remote", url: "https://x.com", headers: "bad" })).toBe("INVALID_HEADERS");
  });
});

describe("isValidMcpName", () => {
  test("my-server → true", () => expect(isValidMcpName("my-server")).toBe(true));
  test("a → true", () => expect(isValidMcpName("a")).toBe(true));
  test("空字符串 → false", () => expect(isValidMcpName("")).toBe(false));
  test("UPPER → false", () => expect(isValidMcpName("UPPER")).toBe(false));
  test("连续连字符 → false", () => expect(isValidMcpName("my--server")).toBe(false));
  test("连字符开头 → false", () => expect(isValidMcpName("-abc")).toBe(false));
});

describe("toServerInfo", () => {
  // local 类型
  test("local 类型", () => {
    const info = toServerInfo("test", {
      type: "local",
      config: { type: "local", command: ["npx", "server"] },
      enabled: true,
    });
    expect(info).toEqual({ name: "test", type: "local", enabled: true, summary: "npx", timeout: undefined });
  });

  // remote 类型
  test("remote 类型", () => {
    const info = toServerInfo("test", {
      type: "remote",
      config: { type: "remote", url: "https://example.com" },
      enabled: true,
    });
    expect(info).toEqual({
      name: "test",
      type: "remote",
      enabled: true,
      summary: "https://example.com",
      timeout: undefined,
    });
  });

  // disabled
  test("disabled", () => {
    const info = toServerInfo("test", { type: "disabled", config: { enabled: false }, enabled: false });
    expect(info).toEqual({ name: "test", type: "disabled", enabled: false, summary: "已禁用" });
  });
});
