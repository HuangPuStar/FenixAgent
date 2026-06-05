import { beforeEach, describe, expect, test } from "bun:test";
import { agentConfigSkill, mcpServer, model, provider } from "../db/schema";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { spawnInstanceFromEnvironment } from "../services/instance";
import { buildLaunchSpec } from "../services/launch-spec-builder";
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
    model: "org_current/provider_demo/gpt-4o",
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
  beforeEach(() => {
    resetAllStubs();
    setListAgentKnowledgeBindingsById(async () => []);
  });

  // 没绑定 agentConfig 的 environment 应直接报配置错误，而不是进入默认 general fallback
  test("environment missing agentConfigId throws INVALID_CONFIG", async () => {
    await expect(
      spawnInstanceFromEnvironment("user_1", "env_1", {
        id: "env_1",
        name: "demo",
        description: null,
        workspacePath: "/tmp/demo",
        agentConfigId: null,
        secret: "sec_1",
        machineName: null,
        directory: null,
        branch: null,
        gitRepoUrl: null,
        maxSessions: 1,
        workerType: "acp",
        capabilities: null,
        status: "idle",
        username: null,
        userId: "user_1",
        organizationId: "org_1",
        autoStart: true,
        lastPollAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: "Environment has no agentConfig bound",
    });
  });

  // agentConfig 没有 model 时必须直接失败，不能再走默认模型兜底
  test("agentConfig missing model throws INVALID_CONFIG", async () => {
    await expect(
      buildLaunchSpec({
        organizationId: "org_current",
        userId: "user_owner",
        agentConfig: createAgentConfig({ model: null }),
        environmentSecret: "secret",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: "AgentConfig 'agc_demo' has no model configured",
    });
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
