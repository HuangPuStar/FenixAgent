import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec, McpServerConfig } from "@fenix/plugin-sdk";
import { buildMcpConfig, buildSettings } from "../runtime/settings";

function createSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "org-test",
    userId: "user-test",
    env: undefined,
    agent: { name: "writer", prompt: "请保持准确" },
    model: {
      provider: "provider-test",
      protocol: "openai",
      baseUrl: "https://models.example.test/v1",
      apiKey: "test-key",
      model: "fallback-model",
      modelName: "named-model",
    },
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

function stdioServer(overrides: Partial<Extract<McpServerConfig, { type: "stdio" }>> = {}): McpServerConfig {
  return {
    name: "filesystem",
    type: "stdio",
    command: "server",
    ...overrides,
  };
}

function httpServer(overrides: Partial<Extract<McpServerConfig, { type: "streamable-http" }>> = {}): McpServerConfig {
  return {
    name: "remote",
    type: "streamable-http",
    url: "https://mcp.example.test/messages",
    ...overrides,
  };
}

describe("Claude Code settings 协议配置", () => {
  // 空 MCP 列表不生成无意义的配置文件内容
  test("空 MCP 列表返回 null", () => {
    expect(buildMcpConfig(createSpec())).toBeNull();
  });

  // stdio 协议保留服务端名称和启动命令
  test("stdio MCP 转换名称与命令", () => {
    expect(buildMcpConfig(createSpec({ mcpServers: [stdioServer()] }))).toEqual({
      mcpServers: { filesystem: { command: "server" } },
    });
  });

  // stdio 协议按原顺序序列化参数数组
  test("stdio MCP 转换参数数组", () => {
    expect(buildMcpConfig(createSpec({ mcpServers: [stdioServer({ args: ["--root", "/workspace"] })] }))).toEqual({
      mcpServers: { filesystem: { command: "server", args: ["--root", "/workspace"] } },
    });
  });

  // stdio 协议透传独立的进程环境
  test("stdio MCP 转换环境变量", () => {
    expect(buildMcpConfig(createSpec({ mcpServers: [stdioServer({ env: { MODE: "test" } })] }))).toEqual({
      mcpServers: { filesystem: { command: "server", env: { MODE: "test" } } },
    });
  });

  // stdio 协议保留工作目录边界
  test("stdio MCP 转换工作目录", () => {
    expect(buildMcpConfig(createSpec({ mcpServers: [stdioServer({ cwd: "/workspace" })] }))).toEqual({
      mcpServers: { filesystem: { command: "server", cwd: "/workspace" } },
    });
  });

  // stdio 可选字段未传时不产生 undefined 序列化字段
  test("stdio MCP 省略未配置的可选字段", () => {
    const config = buildMcpConfig(createSpec({ mcpServers: [stdioServer()] }));
    expect(config?.mcpServers.filesystem).toEqual({ command: "server" });
  });

  // streamable-http 协议输出远端 URL
  test("HTTP MCP 转换 URL", () => {
    expect(buildMcpConfig(createSpec({ mcpServers: [httpServer()] }))).toEqual({
      mcpServers: { remote: { url: "https://mcp.example.test/messages" } },
    });
  });

  // streamable-http 协议透传请求头
  test("HTTP MCP 转换请求头", () => {
    expect(buildMcpConfig(createSpec({ mcpServers: [httpServer({ headers: { "X-Tenant": "org-test" } })] }))).toEqual({
      mcpServers: { remote: { url: "https://mcp.example.test/messages", headers: { "X-Tenant": "org-test" } } },
    });
  });

  // HTTP 协议未配置头部时不产生空对象
  test("HTTP MCP 省略未配置的请求头", () => {
    const config = buildMcpConfig(createSpec({ mcpServers: [httpServer()] }));
    expect("headers" in (config?.mcpServers.remote ?? {})).toBeFalse();
  });

  // 多服务配置按各自名称隔离保存
  test("多个 MCP 服务按名称隔离", () => {
    const config = buildMcpConfig(createSpec({ mcpServers: [stdioServer(), httpServer()] }));
    expect(Object.keys(config?.mcpServers ?? {}).sort()).toEqual(["filesystem", "remote"]);
  });

  // 同名服务遵循输入顺序，由后项覆盖前项
  test("同名 MCP 服务由后一个配置覆盖", () => {
    const config = buildMcpConfig(
      createSpec({ mcpServers: [stdioServer({ command: "first" }), stdioServer({ command: "second" })] }),
    );
    expect(config?.mcpServers.filesystem).toEqual({ command: "second" });
  });

  // MCP 转换不会重排输入数组
  test("MCP 转换保持输入服务顺序", () => {
    const config = buildMcpConfig(
      createSpec({ mcpServers: [httpServer({ name: "zeta" }), stdioServer({ name: "alpha" })] }),
    );
    expect(Object.keys(config?.mcpServers ?? {})).toEqual(["zeta", "alpha"]);
  });

  // OpenAI 协议注入 Claude Code 所需的 API key
  test("OpenAI 协议写入 OPENAI_API_KEY", () => {
    expect(buildSettings(createSpec(), []).env?.OPENAI_API_KEY).toBe("test-key");
  });

  // OpenAI 协议写入自定义 API 地址
  test("OpenAI 协议写入 OPENAI_BASE_URL", () => {
    expect(buildSettings(createSpec(), []).env?.OPENAI_BASE_URL).toBe("https://models.example.test/v1");
  });

  // OpenAI 协议不误写 Anthropic 鉴权变量
  test("OpenAI 协议不写入 Anthropic token", () => {
    expect(buildSettings(createSpec(), []).env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  // Anthropic 协议使用对应的认证变量
  test("Anthropic 协议写入认证 token", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, protocol: "anthropic" } }), []);
    expect(settings.env?.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
  });

  // Anthropic 协议写入其专用 API 地址
  test("Anthropic 协议写入基础地址", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, protocol: "anthropic" } }), []);
    expect(settings.env?.ANTHROPIC_BASE_URL).toBe("https://models.example.test/v1");
  });

  // Anthropic 协议不混入 OpenAI 认证变量
  test("Anthropic 协议不写入 OpenAI key", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, protocol: "anthropic" } }), []);
    expect(settings.env?.OPENAI_API_KEY).toBeUndefined();
  });

  // modelName 同时作为运行时模型与环境变量写入
  test("modelName 写入配置模型字段", () => {
    expect(buildSettings(createSpec(), []).model).toBe("named-model");
  });

  // modelName 注入 Claude Code 可识别的模型环境变量
  test("modelName 写入 ANTHROPIC_MODEL", () => {
    expect(buildSettings(createSpec(), []).env?.ANTHROPIC_MODEL).toBe("named-model");
  });

  // 没有 modelName 时不伪造模型字段
  test("缺少 modelName 时省略模型字段", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, modelName: undefined } }), []);
    expect(settings.model).toBeUndefined();
  });

  // 没有 modelName 时不写模型环境变量
  test("缺少 modelName 时省略模型环境变量", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, modelName: undefined } }), []);
    expect(settings.env?.ANTHROPIC_MODEL).toBeUndefined();
  });

  // 调用方环境变量会被完整保留
  test("额外环境变量被透传", () => {
    expect(buildSettings(createSpec({ env: { FEATURE_FLAG: "on" } }), []).env?.FEATURE_FLAG).toBe("on");
  });

  // 调用方环境变量可以覆盖默认注入值
  test("额外环境变量优先于默认模型环境", () => {
    const settings = buildSettings(createSpec({ env: { OPENAI_API_KEY: "override-key" } }), []);
    expect(settings.env?.OPENAI_API_KEY).toBe("override-key");
  });

  // 调用方环境变量可以覆盖模型名称注入值
  test("额外环境变量可以覆盖模型名称", () => {
    const settings = buildSettings(createSpec({ env: { ANTHROPIC_MODEL: "override-model" } }), []);
    expect(settings.env?.ANTHROPIC_MODEL).toBe("override-model");
  });

  // 空环境对象不增加额外字段且仍保留模型配置
  test("空环境对象不影响模型配置", () => {
    const settings = buildSettings(createSpec({ env: {} }), []);
    expect(settings.model).toBe("named-model");
  });

  // 无 API key 时不写入认证信息
  test("空 API key 不写入认证变量", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, apiKey: "" } }), []);
    expect(settings.env?.OPENAI_API_KEY).toBeUndefined();
  });

  // 无 API key 仍然允许选择模型
  test("空 API key 仍保留模型名称", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, apiKey: "" } }), []);
    expect(settings.model).toBe("named-model");
  });

  // 无基础地址时不序列化空地址字段
  test("空基础地址不写入 OpenAI 地址", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, baseUrl: "" } }), []);
    expect(settings.env?.OPENAI_BASE_URL).toBeUndefined();
  });

  // 无基础地址时仍然保留认证信息
  test("空基础地址仍写入 OpenAI key", () => {
    const settings = buildSettings(createSpec({ model: { ...createSpec().model, baseUrl: "" } }), []);
    expect(settings.env?.OPENAI_API_KEY).toBe("test-key");
  });

  // 仅调用方环境变量时也建立 env 对象
  test("仅额外环境变量时建立 env 对象", () => {
    const settings = buildSettings(
      createSpec({ model: { ...createSpec().model, apiKey: "", modelName: undefined }, env: { ONLY: "value" } }),
      [],
    );
    expect(settings.env).toEqual({ ONLY: "value" });
  });

  // 无可写环境时不生成空 env 对象
  test("没有环境变量时省略 env 对象", () => {
    const settings = buildSettings(
      createSpec({ model: { ...createSpec().model, apiKey: "", modelName: undefined, baseUrl: "" } }),
      [],
    );
    expect(settings.env).toBeUndefined();
  });

  // 安装技能列表不改变设置协议输出
  test("安装技能不影响设置输出", () => {
    const settings = buildSettings(createSpec(), [{ name: "skill-a", path: "/skills/a" }]);
    expect(settings.model).toBe("named-model");
  });

  // 输入环境对象不会被构建过程改写
  test("构建设置不修改输入环境对象", () => {
    const env = { FEATURE_FLAG: "on" };
    buildSettings(createSpec({ env }), []);
    expect(env).toEqual({ FEATURE_FLAG: "on" });
  });

  // 输入 MCP 请求头在转换后保持原对象内容
  test("构建 MCP 配置不修改输入请求头", () => {
    const headers = { "X-Trace": "trace-1" };
    buildMcpConfig(createSpec({ mcpServers: [httpServer({ headers })] }));
    expect(headers).toEqual({ "X-Trace": "trace-1" });
  });

  // 配置结果可安全序列化为 JSON 文本
  test("MCP 配置可 JSON 序列化", () => {
    const config = buildMcpConfig(createSpec({ mcpServers: [stdioServer({ args: ["--json"] })] }));
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });

  // 设置结果可安全序列化为 JSON 文本
  test("设置配置可 JSON 序列化", () => {
    const settings = buildSettings(createSpec({ env: { FEATURE_FLAG: "on" } }), []);
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
  });
});
