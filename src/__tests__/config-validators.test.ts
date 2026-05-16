import { describe, expect, it } from "bun:test";

// 纯函数验证逻辑的单元测试，不依赖数据库
const {
  validateMcpConfig,
  isValidMcpName,
  toServerInfo,
} = await import("../services/config/mcp-server");

const {
  validateAgentData,
  toolsToPermission,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
} = await import("../services/config/agent-config");

const {
  validateWorkspacePath,
  KEBAB_CASE_RE,
} = await import("../services/environment-core");

// ─�� MCP Server 验证 ──

describe("validateMcpConfig", () => {
  // local 类型完整配置
  it("接受有效的 local 配置", () => {
    expect(validateMcpConfig({
      type: "local",
      command: ["npx", "-y", "some-server"],
      environment: { KEY: "val" },
      timeout: 5000,
    })).toBeNull();
  });

  // remote 类型完整配置
  it("接受有效的 remote 配置", () => {
    expect(validateMcpConfig({
      type: "remote",
      url: "https://api.example.com/sse",
      headers: { Authorization: "Bearer token" },
      timeout: 3000,
    })).toBeNull();
  });

  // 仅 enabled:false 的快捷禁用
  it("接受 enabled:false 的快捷禁用配置", () => {
    expect(validateMcpConfig({ enabled: false })).toBeNull();
  });

  // 非 object 输入
  it("拒绝非 object 输入", () => {
    expect(validateMcpConfig("string")).toBe("INVALID_CONFIG");
    expect(validateMcpConfig(null)).toBe("INVALID_CONFIG");
  });

  // 缺少 type 字段
  it("拒绝缺少 type 字段的配置", () => {
    expect(validateMcpConfig({ command: ["npx"] })).toBe("INVALID_CONFIG_TYPE");
  });

  // local 缺少 command
  it("拒绝 local 类型缺少 command", () => {
    expect(validateMcpConfig({ type: "local" })).toBe("INVALID_COMMAND");
  });

  // command 不是数组
  it("拒绝 command 非数组", () => {
    expect(validateMcpConfig({ type: "local", command: "npx" })).toBe("INVALID_COMMAND");
  });

  // remote 缺少 url
  it("拒绝 remote 类型缺少 url", () => {
    expect(validateMcpConfig({ type: "remote" })).toBe("INVALID_URL");
  });

  // 无效 timeout
  it("拒绝无效 timeout（负数或零）", () => {
    expect(validateMcpConfig({ type: "local", command: ["npx"], timeout: -1 })).toBe("INVALID_TIMEOUT");
    expect(validateMcpConfig({ type: "local", command: ["npx"], timeout: 0 })).toBe("INVALID_TIMEOUT");
  });

  // 无效 type
  it("拒绝未知 type", () => {
    expect(validateMcpConfig({ type: "unknown", url: "http://x" })).toBe("INVALID_CONFIG_TYPE");
  });
});

// ── MCP 名称校验 ──

describe("isValidMcpName", () => {
  it("接受合法 kebab-case 名称", () => {
    expect(isValidMcpName("my-server")).toBe(true);
    expect(isValidMcpName("a")).toBe(true);
    expect(isValidMcpName("server-123")).toBe(true);
  });

  it("拒绝空字符串", () => {
    expect(isValidMcpName("")).toBe(false);
  });

  it("拒绝包含连续连字符的名称", () => {
    expect(isValidMcpName("my--server")).toBe(false);
  });

  it("拒绝大写字母", () => {
    expect(isValidMcpName("MyServer")).toBe(false);
  });

  it("拒绝以连字符开头或结尾", () => {
    expect(isValidMcpName("-server")).toBe(false);
    expect(isValidMcpName("server-")).toBe(false);
  });

  it("拒绝超长名称（>64 字符）", () => {
    expect(isValidMcpName("a".repeat(65))).toBe(false);
    expect(isValidMcpName("a".repeat(64))).toBe(true);
  });
});

// ── toServerInfo 转换 ──

describe("toServerInfo", () => {
  // local 类型转换
  it("转换 local 类型", () => {
    const result = toServerInfo("my-server", {
      type: "local",
      config: { type: "local", command: ["/usr/bin/python", "server.py"], timeout: 3000 },
      enabled: true,
    });
    expect(result).toEqual({
      name: "my-server",
      type: "local",
      enabled: true,
      summary: "/usr/bin/python",
      timeout: 3000,
    });
  });

  // remote 类型转换
  it("转换 remote 类型", () => {
    const result = toServerInfo("remote-svc", {
      type: "remote",
      config: { type: "remote", url: "https://api.example.com/sse" },
      enabled: true,
    });
    expect(result).toEqual({
      name: "remote-svc",
      type: "remote",
      enabled: true,
      summary: "https://api.example.com/sse",
      timeout: undefined,
    });
  });

  // disabled 且无 type
  it("转换 disabled 且无 type 的配置", () => {
    const result = toServerInfo("disabled-svc", {
      type: "disabled",
      config: {},
      enabled: false,
    });
    expect(result).toEqual({
      name: "disabled-svc",
      type: "disabled",
      enabled: false,
      summary: "已禁用",
    });
  });
});

// ── Agent Config 验证 ──

describe("validateAgentData", () => {
  // 合法数据
  it("接受合法数据", () => {
    expect(validateAgentData({ mode: "primary", steps: 10, temperature: 0.7 })).toBeNull();
  });

  // 无效 mode
  it("拒绝无效 mode", () => {
    expect(validateAgentData({ mode: "invalid" })).toBe("INVALID_MODE");
  });

  // 无效 steps
  it("拒绝无效 steps（负数或超限）", () => {
    expect(validateAgentData({ steps: 0 })).toBe("INVALID_STEPS");
    expect(validateAgentData({ steps: 201 })).toBe("INVALID_STEPS");
  });

  // 无效 temperature
  it("拒绝无效 temperature", () => {
    expect(validateAgentData({ temperature: -0.1 })).toBe("INVALID_TEMPERATURE");
    expect(validateAgentData({ temperature: 2.1 })).toBe("INVALID_TEMPERATURE");
  });

  // 合法 color
  it("接受合法 color（hex 或预设）", () => {
    expect(validateAgentData({ color: "#FF5733" })).toBeNull();
    expect(validateAgentData({ color: "primary" })).toBeNull();
  });

  // 无效 color
  it("拒绝无效 color", () => {
    expect(validateAgentData({ color: "not-a-color" })).toBe("INVALID_COLOR");
    expect(validateAgentData({ color: "#xyz" })).toBe("INVALID_COLOR");
  });

  // permission 类型检查
  it("拒绝字符串类型的 permission", () => {
    expect(validateAgentData({ permission: "allow" })).toBe("INVALID_PERMISSION");
  });

  it("接受对象类型的 permission", () => {
    expect(validateAgentData({ permission: { bash: "allow" } })).toBeNull();
  });

  it("接受 null permission", () => {
    expect(validateAgentData({ permission: null })).toBeNull();
  });

  // 类型安全：非数字 temperature 不崩溃
  it("非数字 temperature 返回 INVALID_TEMPERATURE", () => {
    expect(validateAgentData({ temperature: "hot" as any })).toBe("INVALID_TEMPERATURE");
    expect(validateAgentData({ temperature: null as any })).toBe("INVALID_TEMPERATURE");
  });

  // 类型安全：非数字 top_p 不崩溃
  it("非数字 top_p 返回 INVALID_TOP_P", () => {
    expect(validateAgentData({ top_p: "high" as any })).toBe("INVALID_TOP_P");
  });

  // 类型安全：非字符串 color 返回 INVALID_COLOR
  it("非字符串 color 返回 INVALID_COLOR", () => {
    expect(validateAgentData({ color: 123 as any })).toBe("INVALID_COLOR");
  });

  // 类型安全：非字符串 mode 跳过校验（不崩溃）
  it("非字符串 mode 跳过校验（不崩溃）", () => {
    expect(validateAgentData({ mode: 123 as any })).toBeNull();
  });

  // 类型安全：非数字 steps 跳过校验（不崩溃）
  it("非数字 steps 跳过校验（不崩溃）", () => {
    expect(validateAgentData({ steps: "ten" as any })).toBeNull();
  });
});

// ── toolsToPermission ──

describe("toolsToPermission", () => {
  it("将布尔值转为三态", () => {
    const result = toolsToPermission({ bash: true, edit: false });
    expect(result).toEqual({ bash: "allow", edit: "deny" });
  });
});

// ── isBuiltInAgent ──

describe("isBuiltInAgent", () => {
  it("识别内置 agent", () => {
    expect(isBuiltInAgent("build")).toBe(true);
    expect(isBuiltInAgent("general")).toBe(true);
    expect(isBuiltInAgent("explore")).toBe(true);
  });

  it("非内置返回 false", () => {
    expect(isBuiltInAgent("my-custom-agent")).toBe(false);
  });
});

// ── normalizeKnowledgeConfig ──

describe("normalizeKnowledgeConfig", () => {
  it("去重并 trim knowledgeBaseIds", () => {
    const result = normalizeKnowledgeConfig({
      knowledgeBaseIds: [" kb1 ", "kb2", " kb1 "],
    });
    expect(result?.knowledgeBaseIds).toEqual(["kb1", "kb2"]);
  });

  it("null 输入返回 null", () => {
    expect(normalizeKnowledgeConfig(null)).toBeNull();
  });

  it("过滤非法值", () => {
    const result = normalizeKnowledgeConfig({
      knowledgeBaseIds: ["valid", "", "  ", "also-valid"],
    });
    expect(result?.knowledgeBaseIds).toEqual(["valid", "also-valid"]);
  });
});

// ── validateWorkspacePath ──

describe("validateWorkspacePath", () => {
  it("拒绝相对路径", () => {
    expect(validateWorkspacePath("relative/path")).toBe("workspace 路径必须是绝对路径");
  });

  it("拒绝系统目录", () => {
    expect(validateWorkspacePath("/etc")).toContain("系统目录");
    expect(validateWorkspacePath("/usr/local")).toContain("系统目录");
  });

  it("接受用户目录", () => {
    expect(validateWorkspacePath("/home/user/project")).toBeNull();
  });
});

// ── KEBAB_CASE_RE ──

describe("KEBAB_CASE_RE", () => {
  it("接受合法 kebab-case", () => {
    expect(KEBAB_CASE_RE.test("my-project")).toBe(true);
    expect(KEBAB_CASE_RE.test("abc123")).toBe(true);
    expect(KEBAB_CASE_RE.test("a")).toBe(true);
  });

  it("拒绝非法格式", () => {
    expect(KEBAB_CASE_RE.test("MyProject")).toBe(false);
    expect(KEBAB_CASE_RE.test("-leading")).toBe(false);
    expect(KEBAB_CASE_RE.test("trailing-")).toBe(false);
    expect(KEBAB_CASE_RE.test("")).toBe(false);
  });
});
