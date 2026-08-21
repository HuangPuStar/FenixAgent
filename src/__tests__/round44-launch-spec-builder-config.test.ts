import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import { agentConfigMcp, agentConfigSkill, mcpServer, member, model, provider } from "../db/schema";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { buildBasicLaunchSpec, buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const now = new Date("2026-08-19T00:00:00.000Z");
const originalConfig = { ...config };

type State = {
  providers?: Record<string, unknown>[];
  models?: Record<string, unknown>[];
  mcpBindings?: Record<string, unknown>[];
  mcps?: Record<string, unknown>[];
};

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), { limit: async () => rows, orderBy: () => queryResult(rows) });
}

function installDb(state: State = {}) {
  stubDb({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === provider) return queryResult(state.providers ?? [providerRow()]);
          if (table === model) return queryResult(state.models ?? [modelRow()]);
          if (table === agentConfigMcp) return queryResult(state.mcpBindings ?? []);
          if (table === mcpServer) return queryResult(state.mcps ?? []);
          if (table === agentConfigSkill || table === member) return queryResult([]);
          return queryResult([]);
        },
      }),
    }),
  });
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider-44",
    userId: "user-44",
    organizationId: "org-44",
    name: "provider-44",
    displayName: "Provider 44",
    protocol: "openai",
    baseUrl: "https://provider.invalid",
    apiKey: null,
    extraOptions: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function modelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "model-44",
    organizationId: "org-44",
    providerId: "provider-44",
    modelId: "model-44-name",
    displayName: "Model 44",
    modalities: null,
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function agentConfig() {
  return {
    id: "agent-44",
    userId: "user-44",
    organizationId: "org-44",
    name: "Agent 44",
    prompt: null,
    modelId: "model-44",
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
    machineId: null,
    createdAt: now,
    updatedAt: now,
    resourceAccess: {
      ownership: "internal" as const,
      sourceOrganizationId: "org-44",
      resourceUid: "agent-44",
      resourceKey: "org-44/agent-44",
      manageable: true,
      writable: true,
      publicReadable: false,
    },
  };
}

async function build(state: State = {}, extraEnv?: Record<string, string>) {
  installDb(state);
  return buildLaunchSpec({
    organizationId: "org-44",
    userId: "user-44",
    environmentId: "environment-44",
    agentConfig: agentConfig(),
    environmentSecret: "",
    ...(extraEnv ? { extraEnv } : {}),
  });
}

describe("round44 launch spec builder 配置转换与环境边界", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig(originalConfig);
    setListAgentKnowledgeBindingsById(async () => []);
  });

  afterEach(() => {
    setListAgentKnowledgeBindingsById(null);
    setConfig(originalConfig);
  });

  // 字符串存储的 streamable-http MCP 配置应完整转换为 SDK 运行时结构。
  test("序列化 streamable-http MCP 被转换并保留连接配置", async () => {
    const spec = await build({
      mcpBindings: [{ mcpServerId: "mcp-http" }],
      mcps: [
        {
          id: "mcp-http",
          name: "HTTP MCP",
          enabled: true,
          type: "streamable-http",
          config: JSON.stringify({
            type: "streamable-http",
            url: "https://mcp.invalid/endpoint",
            headers: { "X-Organization": "org-44" },
            timeout: 12000,
          }),
        },
      ],
    });

    expect(spec.mcpServers).toEqual([
      {
        name: "HTTP MCP",
        type: "streamable-http",
        url: "https://mcp.invalid/endpoint",
        headers: { "X-Organization": "org-44" },
        timeout: 12000,
      },
    ]);
  });

  // 损坏的序列化 MCP 配置必须在启动前被拒绝，不能形成不完整运行时配置。
  test("损坏的序列化 MCP 配置被拒绝", async () => {
    await expect(
      build({
        mcpBindings: [{ mcpServerId: "mcp-invalid" }],
        mcps: [{ id: "mcp-invalid", name: "Invalid MCP", enabled: true, type: "stdio", config: "{" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  // 最小启动规格使用第一个可用模型，同时允许实例环境覆盖受控 Langfuse 值。
  test("最小启动规格透传默认模型且 extraEnv 优先", async () => {
    installDb();
    setConfig({ ...originalConfig, langfusePublicKey: "configured-public" });

    const spec = await buildBasicLaunchSpec({
      organizationId: "org-44",
      userId: "user-44",
      extraEnv: { LANGFUSE_PUBLIC_KEY: "environment-public", INSTANCE_SCOPE: "environment-44" },
    });

    expect(spec).toMatchObject({
      model: { provider: "provider-44", model: "model-44-name" },
      skills: [],
      mcpServers: [],
      env: { LANGFUSE_PUBLIC_KEY: "environment-public", INSTANCE_SCOPE: "environment-44" },
    });
  });

  // 仅声明的 Langfuse 键可以跨受信通道下发，其他同前缀键不应由服务配置注入。
  test("Langfuse 仅透传声明的环境变量", async () => {
    setConfig({
      ...originalConfig,
      langfusePublicKey: "configured-public",
      langfuseSecretKey: "configured-private",
      langfuseBaseUrl: "https://langfuse.invalid",
    });

    const spec = await build();

    expect(spec.env).toEqual({
      LANGFUSE_PUBLIC_KEY: "configured-public",
      LANGFUSE_SECRET_KEY: "configured-private",
      LANGFUSE_BASE_URL: "https://langfuse.invalid",
    });
    expect(spec.env).not.toHaveProperty("LANGFUSE_HOST");
  });
});
