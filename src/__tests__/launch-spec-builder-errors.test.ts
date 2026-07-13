import { beforeEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import { agentConfigMcp, agentConfigSkill, mcpServer, model, provider } from "../db/schema";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { buildBasicLaunchSpec, buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const now = new Date("2026-06-05T00:00:00.000Z");

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

function createAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "agc_demo",
    userId: "user_owner",
    organizationId: "org_current",
    name: "demo",
    prompt: null,
    modelId: "model_demo",
    model: null,
    steps: 10,
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
      sourceOrganizationId: "org_current",
      resourceUid: "agc_demo",
      resourceKey: "org_current/agc_demo",
      manageable: true,
      writable: true,
      publicReadable: false,
    },
    ...overrides,
  };
}

describe("launch spec builder errors", () => {
  const originalConfig = { ...config };

  beforeEach(() => {
    resetAllStubs();
    setConfig(originalConfig as never);
    setListAgentKnowledgeBindingsById(async () => []);
  });

  // 没绑定 agentConfig 时应退回到最小 launch spec，只保留第一个可用模型
  test("buildBasicLaunchSpec uses first available model without extra resources", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => {
              if (table === provider) {
                return Promise.resolve([
                  {
                    id: "provider_demo",
                    userId: "user_owner",
                    organizationId: "org_current",
                    name: "openai",
                    displayName: "OpenAI",
                    protocol: "openai",
                    baseUrl: "https://internal.example.com",
                    apiKey: "internal-key",
                    extraOptions: {},
                    createdAt: now,
                    updatedAt: now,
                  },
                ]);
              }
              return {
                limit: async () => {
                  if (table === model) {
                    return [
                      {
                        id: "model_demo",
                        organizationId: "org_current",
                        providerId: "provider_demo",
                        modelId: "gpt-4o",
                        displayName: "GPT-4o",
                        modalities: null,
                        limitConfig: null,
                        cost: null,
                        options: null,
                        createdAt: now,
                        updatedAt: now,
                      },
                    ];
                  }
                  return [];
                },
              };
            },
          }),
        }),
      }),
    });

    await expect(
      buildBasicLaunchSpec({
        organizationId: "org_current",
        userId: "user_owner",
        environmentId: "env_basic",
      }),
    ).resolves.toEqual({
      organizationId: "org_current",
      userId: "user_owner",
      environmentId: "env_basic",
      env: {},
      agent: {
        name: "build",
        prompt: expect.stringContaining("FENIXAGENT"),
      },
      model: {
        provider: "openai",
        protocol: "openai",
        baseUrl: "https://internal.example.com",
        apiKey: "internal-key",
        model: "gpt-4o",
        modelName: "gpt-4o",
      },
      skills: [],
      mcpServers: [],
    });
  });

  // agentConfig 未指定 model 时回退到组织第一个可用模型
  test("agentConfig missing model falls back to first available model", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return {
                orderBy: () =>
                  Promise.resolve([
                    {
                      id: "provider_demo",
                      userId: "user_owner",
                      organizationId: "org_current",
                      name: "openai",
                      displayName: "OpenAI",
                      protocol: "openai",
                      baseUrl: "https://internal.example.com",
                      apiKey: "internal-key",
                      extraOptions: {},
                      createdAt: now,
                      updatedAt: now,
                    },
                  ]),
              };
            }
            if (table === model) {
              return {
                orderBy: () => ({
                  limit: () =>
                    Promise.resolve([
                      {
                        id: "model_demo",
                        userId: "user_owner",
                        organizationId: "org_current",
                        providerId: "provider_demo",
                        modelId: "gpt-4o",
                        name: null,
                        displayName: null,
                        capability: { vision: false, functionCalling: true },
                        defaultParams: {},
                        contextLimit: 128000,
                        cost: {},
                        permission: null,
                        supported: true,
                        customParams: {},
                        createdAt: now,
                        updatedAt: now,
                      },
                    ]),
                }),
              };
            }
            return queryResult([]);
          },
        }),
      }),
    });
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig({ modelId: null }),
      environmentSecret: "secret",
    });
    expect(spec.model.model).toBe("gpt-4o");
  });

  // 平台系统 prompt 模板支持从主服务配置覆盖
  test("buildLaunchSpec uses configured agent system prompt template", async () => {
    setConfig({
      agentSystemPrompt:
        "你是 MyAgent。\n{{userPrompt}}\n你当前的 Agent 名称是「{{agentName}}」。\n始终回答你是 MyAgent。",
    } as never);
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return queryResult([
                {
                  id: "provider_demo",
                  userId: "user_owner",
                  organizationId: "org_current",
                  name: "openai",
                  displayName: "OpenAI",
                  protocol: "openai",
                  baseUrl: "https://internal.example.com",
                  apiKey: "internal-key",
                  extraOptions: {},
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (table === model) {
              return queryResult([
                {
                  id: "model_demo",
                  organizationId: "org_current",
                  providerId: "provider_demo",
                  modelId: "gpt-4o",
                  displayName: "GPT-4o",
                  modalities: null,
                  limitConfig: null,
                  cost: null,
                  options: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (table === agentConfigSkill || table === agentConfigMcp || table === mcpServer) return queryResult([]);
            return queryResult([]);
          },
        }),
      }),
    });

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig({ prompt: "You are helpful" }),
      environmentSecret: "secret",
    });
    const prompt = spec.agent.prompt ?? "";

    expect(prompt).toContain("MyAgent");
    expect(prompt).toContain("你当前的 Agent 名称是「demo」。");
    expect(prompt).toContain("You are helpful");
    expect(prompt.indexOf("You are helpful")).toBeLessThan(prompt.indexOf("始终回答你是 MyAgent。"));
  });

  // MCP 配置非法时必须直接失败，避免把错误推迟到运行时
  test("invalid MCP json throws INVALID_CONFIG", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return queryResult([
                {
                  id: "provider_demo",
                  userId: "user_owner",
                  organizationId: "org_current",
                  name: "openai",
                  displayName: "OpenAI",
                  protocol: "openai",
                  baseUrl: "https://internal.example.com",
                  apiKey: "internal-key",
                  extraOptions: {},
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (table === model) {
              return queryResult([
                {
                  id: "model_demo",
                  organizationId: "org_current",
                  providerId: "provider_demo",
                  modelId: "gpt-4o",
                  displayName: "GPT-4o",
                  modalities: null,
                  limitConfig: null,
                  cost: null,
                  options: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (table === agentConfigSkill) return queryResult([]);
            if (table === agentConfigMcp) return queryResult([{ mcpServerId: "mcp_invalid" }]);
            if (table === mcpServer) {
              return queryResult([
                {
                  id: "mcp_invalid",
                  userId: "user_owner",
                  organizationId: "org_current",
                  name: "broken-mcp",
                  type: "remote",
                  config: "{invalid json",
                  enabled: true,
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            return queryResult([]);
          },
        }),
      }),
    });

    await expect(
      buildLaunchSpec({
        organizationId: "org_current",
        userId: "user_owner",
        agentConfig: createAgentConfig(),
        environmentSecret: "secret",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: "AgentConfig 'agc_demo' has invalid MCP config 'broken-mcp'",
    });
  });
});
