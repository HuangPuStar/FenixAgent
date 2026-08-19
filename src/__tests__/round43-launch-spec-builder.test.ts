import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import { agentConfigMcp, agentConfigSkill, mcpServer, member, model, provider, skill } from "../db/schema";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { buildBasicLaunchSpec, buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const now = new Date("2026-08-19T00:00:00.000Z");
const originalConfig = { ...config };

type State = {
  providers?: Record<string, unknown>[];
  models?: Record<string, unknown>[];
  skillBindings?: Record<string, unknown>[];
  skills?: Record<string, unknown>[];
  mcpBindings?: Record<string, unknown>[];
  mcps?: Record<string, unknown>[];
  members?: Record<string, unknown>[];
};

function result<T>(value: T[]) {
  return Object.assign(Promise.resolve(value), { limit: async () => value, orderBy: () => result(value) });
}

function installDb(state: State = {}) {
  stubDb({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === provider) return result(state.providers ?? [providerRow()]);
          if (table === model) return result(state.models ?? [modelRow()]);
          if (table === agentConfigSkill) return result(state.skillBindings ?? []);
          if (table === skill) return result(state.skills ?? []);
          if (table === agentConfigMcp) return result(state.mcpBindings ?? []);
          if (table === mcpServer) return result(state.mcps ?? []);
          if (table === member) return result(state.members ?? []);
          return result([]);
        },
      }),
    }),
  });
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider-43",
    userId: "user-43",
    organizationId: "org-43",
    name: "provider-43",
    displayName: "Provider 43",
    protocol: "openai",
    baseUrl: "https://provider.invalid",
    apiKey: "{env:ROUND43_API_KEY}",
    extraOptions: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function modelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "model-43",
    organizationId: "org-43",
    providerId: "provider-43",
    modelId: "model-43-name",
    displayName: "Model 43",
    modalities: ["text"],
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function agentConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-43",
    userId: "user-43",
    organizationId: "org-43",
    name: "Agent 43",
    prompt: "处理已授权的请求",
    modelId: "model-43",
    model: null,
    steps: 8,
    mode: "primary",
    permission: null,
    variant: null,
    temperature: null,
    topP: null,
    disable: false,
    hidden: false,
    color: null,
    description: null,
    knowledge: null,
    machineId: "machine-43",
    createdAt: now,
    updatedAt: now,
    resourceAccess: {
      ownership: "internal" as const,
      sourceOrganizationId: "org-43",
      resourceUid: "agent-43",
      resourceKey: "org-43/agent-43",
      manageable: true,
      writable: true,
      publicReadable: false,
    },
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-43",
    userId: "user-43",
    environmentId: "environment-43",
    agentConfig: agentConfig(),
    environmentSecret: "environment-secret-43",
    ...overrides,
  };
}

async function build(state: State = {}, overrides: Record<string, unknown> = {}) {
  installDb(state);
  return buildLaunchSpec(input(overrides));
}

describe("round43 launch spec builder 真实业务语义", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig(originalConfig as never);
    setListAgentKnowledgeBindingsById(async () => []);
    delete process.env.ROUND43_API_KEY;
    delete process.env.HINDSIGHT_MCP_URL;
    delete process.env.HINDSIGHT_API_TOKEN;
  });

  afterEach(() => {
    setListAgentKnowledgeBindingsById(null);
    delete process.env.ROUND43_API_KEY;
    delete process.env.HINDSIGHT_MCP_URL;
    delete process.env.HINDSIGHT_API_TOKEN;
  });

  // 显式模型只解析当前 AgentConfig 指向的模型和 provider。
  test("显式模型构成完整启动规格", async () => {
    process.env.ROUND43_API_KEY = "scoped-key";
    const spec = await build();
    expect(spec.organizationId).toBe("org-43");
    expect(spec.userId).toBe("user-43");
    expect(spec.model).toMatchObject({
      provider: "provider-43",
      protocol: "openai",
      apiKey: "scoped-key",
      model: "model-43-name",
    });
  });

  // 环境 ID 为空时不向运行时发送空字段。
  test("空 environmentId 被省略", async () => {
    const spec = await build({}, { environmentId: undefined });
    expect("environmentId" in spec).toBe(false);
  });

  // Agent 的 machineId 不会越权改变启动规格所属用户和组织。
  test("machine 配置不改变调用方隔离标识", async () => {
    const spec = await build(
      {},
      { agentConfig: agentConfig({ machineId: "machine-other", organizationId: "org-other", userId: "user-other" }) },
    );
    expect(spec.organizationId).toBe("org-43");
    expect(spec.userId).toBe("user-43");
  });

  // Anthropic 是 SDK 支持的第二种模型协议。
  test("anthropic provider 协议被保留", async () => {
    const spec = await build({ providers: [providerRow({ protocol: "anthropic" })] });
    expect(spec.model.protocol).toBe("anthropic");
  });

  // 未知 provider 协议必须在启动前失败。
  test("未知 provider 协议被拒绝", async () => {
    await expect(build({ providers: [providerRow({ protocol: "azure" })] })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  // 缺失的显式模型外键不能静默回退。
  test("缺失显式模型被拒绝", async () => {
    await expect(build({ models: [] })).rejects.toMatchObject({
      message: "AgentConfig 'agent-43' references missing model id 'model-43'",
    });
  });

  // 模型存在而 provider 消失时必须暴露损坏配置。
  test("缺失模型 provider 被拒绝", async () => {
    await expect(build({ providers: [], models: [modelRow()] })).rejects.toMatchObject({
      message: "AgentConfig 'agent-43' references missing provider for model 'model-43'",
    });
  });

  // 未配置的 env 引用不会把引用文本作为 API key 下发。
  test("缺失 provider 环境变量产生空 API key", async () => {
    const spec = await build();
    expect(spec.model.apiKey).toBe("");
  });

  // 数据库模型的 modalities 会原样传给运行时。
  test("模型 modalities 被保留", async () => {
    const spec = await build({ models: [modelRow({ modalities: ["text", "image"] })] });
    expect(spec.model.modalities).toEqual(["text", "image"]);
  });

  // 无 AgentConfig 模式会跳过没有模型的 provider。
  test("最小规格跳过无模型 provider", async () => {
    installDb({ providers: [providerRow({ id: "empty-provider" }), providerRow()], models: [modelRow()] });
    const spec = await buildBasicLaunchSpec({ organizationId: "org-43", userId: "user-43" });
    expect(spec.model.provider).toBe("provider-43");
  });

  // 无任何可用模型时最小启动路径不能伪造成功。
  test("最小规格没有模型时失败", async () => {
    installDb({ providers: [providerRow()], models: [] });
    await expect(buildBasicLaunchSpec({ organizationId: "org-43", userId: "user-43" })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  // local MCP 只保留字符串命令参数，防止非字符串进入进程启动配置。
  test("local MCP 过滤非字符串参数", async () => {
    const spec = await build({
      mcpBindings: [{ mcpServerId: "mcp-1" }],
      mcps: [
        {
          id: "mcp-1",
          name: "local",
          enabled: true,
          type: "local",
          config: { type: "local", command: ["bun", "run", 9, "server"], environment: { SAFE: "1" }, timeout: 20 },
        },
      ],
    });
    expect(spec.mcpServers).toEqual([
      expect.objectContaining({ type: "stdio", command: "bun", args: ["run", "server"], timeout: 20 }),
    ]);
  });

  // stdio MCP 同样过滤非字符串 args。
  test("stdio MCP 过滤非字符串参数", async () => {
    const spec = await build({
      mcpBindings: [{ mcpServerId: "mcp-1" }],
      mcps: [
        {
          id: "mcp-1",
          name: "stdio",
          enabled: true,
          type: "stdio",
          config: { type: "stdio", command: "node", args: ["a", false, "b"] },
        },
      ],
    });
    expect(spec.mcpServers[0]).toMatchObject({ type: "stdio", command: "node", args: ["a", "b"] });
  });

  // remote MCP 会转换为受支持的 streamable-http 类型并保留 headers。
  test("remote MCP 转换为 streamable http", async () => {
    const spec = await build({
      mcpBindings: [{ mcpServerId: "mcp-1" }],
      mcps: [
        {
          id: "mcp-1",
          name: "remote",
          enabled: true,
          type: "remote",
          config: { type: "remote", url: "https://mcp.invalid", headers: { "X-Scope": "org-43" } },
        },
      ],
    });
    expect(spec.mcpServers[0]).toMatchObject({
      type: "streamable-http",
      url: "https://mcp.invalid",
      headers: { "X-Scope": "org-43" },
    });
  });

  // 空 remote URL 不可作为运行时连接目标。
  test("空 remote MCP URL 被拒绝", async () => {
    await expect(
      build({
        mcpBindings: [{ mcpServerId: "mcp-1" }],
        mcps: [{ id: "mcp-1", name: "remote", enabled: true, type: "remote", config: { type: "remote", url: " " } }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  // local MCP 必须声明字符串可执行命令。
  test("local MCP 缺少命令被拒绝", async () => {
    await expect(
      build({
        mcpBindings: [{ mcpServerId: "mcp-1" }],
        mcps: [{ id: "mcp-1", name: "local", enabled: true, type: "local", config: { type: "local", command: [] } }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  // 不支持的 MCP 类型不能被静默丢弃。
  test("未知 MCP 类型被拒绝", async () => {
    await expect(
      build({
        mcpBindings: [{ mcpServerId: "mcp-1" }],
        mcps: [{ id: "mcp-1", name: "unknown", enabled: true, type: "custom", config: { type: "socket" } }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  // 禁用 MCP 即使仍有绑定也不能下发。
  test("禁用 MCP 被拒绝", async () => {
    await expect(
      build({
        mcpBindings: [{ mcpServerId: "mcp-1" }],
        mcps: [
          { id: "mcp-1", name: "disabled", enabled: false, type: "stdio", config: { type: "stdio", command: "node" } },
        ],
      }),
    ).rejects.toMatchObject({ message: "AgentConfig 'agent-43' references disabled MCP servers" });
  });

  // 存在绑定但找不到 MCP 行时必须阻断启动。
  test("缺失绑定 MCP 被拒绝", async () => {
    await expect(build({ mcpBindings: [{ mcpServerId: "missing-mcp" }], mcps: [] })).rejects.toMatchObject({
      message: "AgentConfig 'agent-43' references missing MCP servers",
    });
  });

  // MCP 输出顺序必须遵从绑定顺序而不是数据库返回顺序。
  test("MCP 保持绑定顺序", async () => {
    const spec = await build({
      mcpBindings: [{ mcpServerId: "second" }, { mcpServerId: "first" }],
      mcps: [
        { id: "first", name: "first", enabled: true, type: "stdio", config: { type: "stdio", command: "first" } },
        { id: "second", name: "second", enabled: true, type: "stdio", config: { type: "stdio", command: "second" } },
      ],
    });
    expect(spec.mcpServers.map((item) => item.name)).toEqual(["second", "first"]);
  });

  // Knowledge 绑定追加受环境密钥保护的平台 MCP。
  test("knowledge 绑定注入受保护 MCP", async () => {
    setListAgentKnowledgeBindingsById(async () => [
      { knowledgeBaseId: "kb-43", priority: 0, enabled: true, config: null },
    ]);
    const spec = await build();
    expect(spec.mcpServers).toContainEqual(
      expect.objectContaining({
        name: "kb",
        headers: { Authorization: "Bearer environment-secret-43" },
        timeout: 15000,
      }),
    );
  });

  // 调用方 extraEnv 优先于受控 Langfuse 配置，便于环境级隔离覆盖。
  test("extraEnv 覆盖 Langfuse 配置", async () => {
    setConfig({ langfusePublicKey: "configured-public" } as never);
    const spec = await build({}, { extraEnv: { LANGFUSE_PUBLIC_KEY: "environment-public" } });
    expect(spec.env.LANGFUSE_PUBLIC_KEY).toBe("environment-public");
  });

  // 未启用 Hindsight 时保留用户的普通 agent extra，不读取全局敏感环境变量。
  test("未启用记忆时保留 agent extra", async () => {
    process.env.HINDSIGHT_MCP_URL = "https://hindsight.invalid";
    const spec = await build(
      {},
      { agentConfig: agentConfig({ extra: { engine: "ccb", plugin: [["other", { enabled: true }]] } }) },
    );
    expect(spec.agent.extra).toEqual({ engine: "ccb", plugin: [["other", { enabled: true }]] });
    expect(spec.env.HINDSIGHT_API_URL).toBeUndefined();
  });
});
