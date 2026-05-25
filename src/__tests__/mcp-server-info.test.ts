import { describe, expect, it } from "bun:test";

// 测试 mcp-server.ts 的 toServerInfo 纯函数：command 数组守卫
const { toServerInfo } = await import("../services/config/mcp-server");

describe("toServerInfo", () => {
  // 禁用且无 type 的配置返回 disabled 类型
  it("禁用且无 type 返回 disabled 类型", () => {
    const result = toServerInfo("test", { type: "", config: {}, enabled: false });
    expect(result.type).toBe("disabled");
    expect(result.enabled).toBe(false);
  });

  // local 类型正确解析 command 数组
  it("local 类型解析 command 数组", () => {
    const result = toServerInfo("my-server", {
      type: "local",
      config: { type: "local", command: ["npx", "-y", "server-github"] },
      enabled: true,
    });
    expect(result.type).toBe("local");
    expect(result.summary).toBe("npx");
  });

  // command 为非数组时安全降级（数组守卫）
  it("command 为非数组时安全降级为空字符串", () => {
    const result = toServerInfo("bad-server", {
      type: "local",
      config: { type: "local", command: "not-an-array" },
      enabled: true,
    });
    expect(result.type).toBe("local");
    expect(result.summary).toBe("");
  });

  // command 缺失时安全降级
  it("command 缺失时安全降级", () => {
    const result = toServerInfo("no-cmd", {
      type: "local",
      config: { type: "local" },
      enabled: true,
    });
    expect(result.type).toBe("local");
    expect(result.summary).toBe("");
  });

  // remote 类型正确解析 url
  it("remote 类型解析 url", () => {
    const result = toServerInfo("remote-server", {
      type: "remote",
      config: { type: "remote", url: "https://api.example.com/sse" },
      enabled: true,
    });
    expect(result.type).toBe("remote");
    expect(result.summary).toBe("https://api.example.com/sse");
  });

  // remote 类型无 url 时降级
  it("remote 类型无 url 时降级为空字符串", () => {
    const result = toServerInfo("no-url", {
      type: "remote",
      config: { type: "remote" },
      enabled: true,
    });
    expect(result.type).toBe("remote");
    expect(result.summary).toBe("");
  });

  // timeout 正确透传
  it("透传 timeout 配置", () => {
    const result = toServerInfo("timeout-server", {
      type: "local",
      config: { type: "local", command: ["npx", "server"], timeout: 5000 },
      enabled: true,
    });
    expect(result.timeout).toBe(5000);
  });

  // streamable-http 类型正确识别
  it("streamable-http 类型正确识别", () => {
    const result = toServerInfo("stream-server", {
      type: "streamable-http",
      config: { type: "streamable-http", url: "https://api.example.com/mcp" },
      enabled: true,
    });
    expect(result.type).toBe("streamable-http");
    expect(result.summary).toBe("https://api.example.com/mcp");
  });

  // streamable-http 无 url 时降级
  it("streamable-http 无 url 时降级为空字符串", () => {
    const result = toServerInfo("stream-no-url", {
      type: "streamable-http",
      config: { type: "streamable-http" },
      enabled: true,
    });
    expect(result.type).toBe("streamable-http");
    expect(result.summary).toBe("");
  });

  // 未知类型归为 remote
  it("未知类型归为 remote", () => {
    const result = toServerInfo("unknown-server", {
      type: "custom",
      config: { type: "custom", url: "https://custom.example.com" },
      enabled: true,
    });
    expect(result.type).toBe("remote");
  });
});
