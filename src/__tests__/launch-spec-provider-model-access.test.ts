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

function createAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "agc_demo",
    userId: "user_owner",
    organizationId: "org_current",
    name: "demo",
    prompt: null,
    modelId: "model_internal",
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

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider_internal",
    userId: "user_owner",
    organizationId: "org_current",
    name: "openai",
    displayName: "OpenAI",
    protocol: "openai" as const,
    baseUrl: "https://internal.example.com",
    apiKey: "internal-key",
    extraOptions: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("launch spec provider model access", () => {
  beforeEach(() => {
    resetAllStubs();
    setListAgentKnowledgeBindingsById(async () => []);
  });

  // 旧 provider/model 引用在同名 provider 存在时优先使用当前组织 provider
  test("旧 provider model 引用优先当前组织 provider", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return queryResult([
                providerRow({ id: "provider_internal", organizationId: "org_current", apiKey: "internal-key" }),
                providerRow({
                  id: "provider_shadow",
                  organizationId: "org_current",
                  displayName: "openai",
                  apiKey: "shadow-key",
                  baseUrl: "https://shadow.example.com",
                }),
              ]);
            }
            if (table === model) {
              return queryResult([
                {
                  id: "model_internal",
                  organizationId: "org_current",
                  providerId: "provider_internal",
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
            if (table === mcpServer) return queryResult([]);
            return queryResult([]);
          },
        }),
      }),
    });

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig(),
      environmentSecret: "secret",
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      apiKey: "internal-key",
      baseUrl: "https://internal.example.com",
      model: "gpt-4o",
    });
  });

  // 稳定 sourceOrg/providerUid/model 引用会精确解析到共享 provider
  test("稳定 model 引用解析到共享 provider", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return queryResult([
                providerRow({
                  id: "provider_external",
                  organizationId: "org_source",
                  userId: "user_source",
                  apiKey: "external-key",
                  baseUrl: "https://external.example.com",
                }),
              ]);
            }
            if (table === model) {
              return queryResult([
                {
                  id: "model_external",
                  organizationId: "org_source",
                  providerId: "provider_external",
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
            if (table === mcpServer) return queryResult([]);
            return queryResult([]);
          },
        }),
      }),
    });

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig({
        id: "agc_shared",
        organizationId: "org_source",
        userId: "user_source",
        resourceAccess: {
          ownership: "external",
          sourceOrganizationId: "org_source",
          resourceUid: "agc_shared",
          resourceKey: "org_source/agc_shared",
          manageable: false,
          writable: false,
          publicReadable: true,
        },
        model: null,
        modelId: "model_external",
      }),
      environmentSecret: "secret",
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      apiKey: "external-key",
      baseUrl: "https://external.example.com",
      model: "shared-model",
    });
  });

  // provider 缺失时必须直接失败，不能再回落到空 key 的默认模型
  test("缺少 provider 时直接抛 INVALID_CONFIG", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) return queryResult([]);
            if (table === model) return queryResult([]);
            if (table === agentConfigSkill) return queryResult([]);
            if (table === mcpServer) return queryResult([]);
            return queryResult([]);
          },
        }),
      }),
    });

    await expect(
      buildLaunchSpec({
        organizationId: "org_current",
        userId: "user_owner",
        agentConfig: createAgentConfig({
          model: null,
          modelId: "missing_model",
        }),
        environmentSecret: "secret",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  // provider 存在但 model 行缺失时也必须直接失败，避免引用不存在的模型定义
  test("缺少 model 行时直接抛 INVALID_CONFIG", async () => {
    stubDb({
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === provider) {
              return queryResult([
                providerRow({ id: "provider_internal", organizationId: "org_current", apiKey: "internal-key" }),
              ]);
            }
            if (table === model) return queryResult([]);
            if (table === agentConfigSkill) return queryResult([]);
            if (table === mcpServer) return queryResult([]);
            return queryResult([]);
          },
        }),
      }),
    });

    await expect(
      buildLaunchSpec({
        organizationId: "org_current",
        userId: "user_owner",
        agentConfig: createAgentConfig({ modelId: "missing_model" }),
        environmentSecret: "secret",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: "AgentConfig 'agc_demo' references missing model id 'missing_model'",
    });
  });
});
