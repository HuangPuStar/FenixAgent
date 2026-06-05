import { beforeEach, describe, expect, test } from "bun:test";
import { agentConfigSkill, mcpServer, model, provider } from "../db/schema";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const now = new Date("2026-06-01T00:00:00.000Z");

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

function createAgentConfig() {
  return {
    id: "agc_demo",
    userId: "user_owner",
    organizationId: "org_source",
    name: "demo",
    prompt: null,
    model: "org_source/provider_external/gpt-4o",
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
      ownership: "external" as const,
      sourceOrganizationId: "org_source",
      resourceUid: "agc_demo",
      resourceKey: "org_source/agc_demo",
      manageable: false,
      writable: false,
      publicReadable: true,
    },
  };
}

describe("launch spec MCP resource access", () => {
  beforeEach(() => {
    resetAllStubs();
    setListAgentKnowledgeBindingsById(async () => []);
  });

  // builder 会直接读取 agentConfig 所属组织的 enabled MCP，并翻译成 SDK 配置
  test("buildLaunchSpec 读取并转换 enabled MCP", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return queryResult([
                {
                  id: "provider_external",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "openai",
                  displayName: "OpenAI",
                  protocol: "openai",
                  baseUrl: "https://external.example.com",
                  apiKey: "external-key",
                  extraOptions: {},
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            }
            if (table === model) {
              return queryResult([
                {
                  id: "model_external",
                  organizationId: "org_source",
                  providerId: "provider_external",
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
                  id: "mcp_external_enabled",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "external-enabled",
                  type: "remote",
                  config: {
                    type: "remote",
                    url: "https://external.example.com",
                    headers: { Authorization: "Bearer x" },
                  },
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
      environmentId: "env_1",
      agentConfig: createAgentConfig(),
      environmentSecret: "secret",
    });

    expect(spec.mcpServers).toEqual([
      {
        name: "external-enabled",
        type: "streamable-http",
        url: "https://external.example.com",
        headers: { Authorization: "Bearer x" },
        timeout: undefined,
      },
    ]);
  });
});
