import { beforeEach, describe, expect, test } from "bun:test";
import { agentConfigSkill, mcpServer, model, provider } from "../db/schema";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const now = new Date("2026-06-04T00:00:00.000Z");

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

function createSharedAgentConfig() {
  return {
    id: "agc_external",
    userId: "user_source",
    organizationId: "org_source",
    name: "shared-agent",
    prompt: "shared prompt",
    model: "org_source/prov_source/shared-model",
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
    knowledge: { knowledgeBaseIds: ["kb-private"] },
    machineId: "machine-source",
    createdAt: now,
    updatedAt: now,
    resourceAccess: {
      ownership: "external" as const,
      sourceOrganizationId: "org_source",
      sourceOrganizationName: "Source Team",
      resourceUid: "agc_external",
      resourceKey: "org_source/agc_external",
      manageable: false,
      writable: false,
      publicReadable: true,
    },
  };
}

describe("launch spec agent sharing access", () => {
  beforeEach(() => {
    resetAllStubs();
    setListAgentKnowledgeBindingsById(async () => [{ knowledgeBaseId: "kb-private", priority: 0, enabled: true }]);
  });

  // 共享 Agent 会按源组织精准取 provider 与 enabled MCP，并补上 knowledge MCP
  test("buildLaunchSpec 使用共享 Agent 依赖生成 LaunchSpec", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return queryResult([
                {
                  id: "prov_source",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "openai",
                  displayName: "OpenAI",
                  protocol: "openai",
                  baseUrl: "https://source.example.com",
                  apiKey: "source-key",
                  extraOptions: {},
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (table === model) {
              return queryResult([
                {
                  id: "model_source",
                  organizationId: "org_source",
                  providerId: "prov_source",
                  modelId: "shared-model",
                  displayName: "Shared Model",
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
                  id: "mcp_enabled",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "external-enabled",
                  type: "remote",
                  config: { type: "remote", url: "https://mcp.example.com" },
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

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      environmentId: "env_shared",
      agentConfig: createSharedAgentConfig(),
      environmentSecret: "secret",
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      baseUrl: "https://source.example.com",
      apiKey: "source-key",
      model: "shared-model",
    });
    expect(spec.mcpServers[0]).toEqual({
      name: "external-enabled",
      type: "streamable-http",
      url: "https://mcp.example.com",
      headers: undefined,
      timeout: undefined,
    });
    expect(spec.mcpServers[1]).toMatchObject({
      name: "kb",
      type: "streamable-http",
      headers: { Authorization: "Bearer secret" },
      timeout: 15000,
    });
    expect(spec.mcpServers[1]?.type === "streamable-http" ? spec.mcpServers[1].url : "").toContain("/mcp/knowledge");
  });
});
