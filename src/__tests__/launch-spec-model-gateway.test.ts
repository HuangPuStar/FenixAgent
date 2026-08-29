import { beforeEach, describe, expect, test } from "bun:test";
import { agentConfigMcp, agentConfigSkill, mcpServer, model, provider } from "../db/schema";
import { buildLaunchSpec, setRuntimeCredentialResolver } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const now = new Date("2026-06-01T00:00:00.000Z");

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
    orderBy: async () => rows,
  });
}

function createAgentConfig() {
  return {
    id: "agent-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "demo",
    prompt: null,
    modelId: "model-1",
    model: null,
    steps: 10,
    mode: "primary" as const,
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
      sourceOrganizationId: "org-1",
      resourceUid: "agent-1",
      resourceKey: "org-1/agent-1",
      manageable: true,
      writable: true,
      publicReadable: false,
    },
  };
}

function installDb(providerOverrides: Record<string, unknown> = {}) {
  stubDb({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === provider) {
            return queryResult([
              {
                id: "gateway-provider",
                userId: "admin",
                organizationId: "org-1",
                name: "fenix-model-gateway",
                displayName: "模型网关",
                kind: "gateway" as const,
                gatewayType: "litellm",
                protocol: "openai" as const,
                baseUrl: "http://gateway",
                apiKey: null,
                extraOptions: null,
                createdAt: now,
                updatedAt: now,
                ...providerOverrides,
              },
            ]);
          }
          if (table === model) {
            return queryResult([
              {
                id: "model-1",
                organizationId: "org-1",
                providerId: "gateway-provider",
                modelId: "gpt-test",
                displayName: "GPT Test",
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
}

describe("launch spec model gateway", () => {
  beforeEach(() => {
    resetAllStubs();
    setRuntimeCredentialResolver(null);
  });

  // 验证 Gateway Provider 启动时使用运行时动态 Key，不读取 Provider 静态 apiKey。
  test("Gateway Provider 使用运行时动态 Key，不读取 Provider apiKey", async () => {
    installDb();
    setRuntimeCredentialResolver(async (input) => {
      expect(input).toMatchObject({
        gatewayProviderId: "gateway-provider",
        organizationId: "org-1",
        userId: "user-1",
        agentConfigId: "agent-1",
      });
      return { status: "ready", externalCredentialId: "key-1", secret: "runtime-secret" };
    });

    const spec = await buildLaunchSpec({
      organizationId: "org-1",
      userId: "user-1",
      agentConfig: createAgentConfig(),
      environmentSecret: "environment-secret",
    });

    expect(spec.model).toMatchObject({
      provider: "fenix-model-gateway",
      baseUrl: "http://gateway",
      apiKey: "runtime-secret",
      model: "gpt-test",
    });
  });

  // 验证用户全局预算耗尽时，在构建 LaunchSpec 前阻止 Agent 启动。
  test("Gateway Provider 用户预算耗尽时阻止启动", async () => {
    installDb();
    setRuntimeCredentialResolver(async () => ({ status: "budget-exhausted" }));

    await expect(
      buildLaunchSpec({
        organizationId: "org-1",
        userId: "user-1",
        agentConfig: createAgentConfig(),
        environmentSecret: "environment-secret",
      }),
    ).rejects.toMatchObject({
      code: "MODEL_GATEWAY_BUDGET_EXHAUSTED",
      statusCode: 400,
      message: "模型网关预算已耗尽，无法启动 Agent",
    });
  });

  // 验证网关凭证服务未装配时直接失败，避免错误回退到普通 Provider Key。
  test("Gateway Provider 未装配凭证服务时直接失败，不回退到普通 Key", async () => {
    installDb({ apiKey: "must-not-be-used" });

    await expect(
      buildLaunchSpec({
        organizationId: "org-1",
        userId: "user-1",
        agentConfig: createAgentConfig(),
        environmentSecret: "environment-secret",
      }),
    ).rejects.toThrow("requires a configured model gateway");
  });
});
