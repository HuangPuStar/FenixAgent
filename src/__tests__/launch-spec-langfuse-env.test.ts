import { beforeEach, describe, expect, test } from "bun:test";
import { setConfig } from "../config";
import { agentConfigMcp, agentConfigSkill, mcpServer, model, provider } from "../db/schema";
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
    apiKey: "internal-key",
    baseUrl: "https://internal.example.com",
    options: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function stubModelAndProvider() {
  stubDb({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === provider) {
            return queryResult([providerRow()]);
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
          if (table === agentConfigSkill || table === agentConfigMcp) return queryResult([]);
          if (table === mcpServer) return queryResult([]);
          return queryResult([]);
        },
      }),
    }),
  });
}

describe("launch spec langfuse env 透传", () => {
  beforeEach(() => {
    resetAllStubs();
    setListAgentKnowledgeBindingsById(async () => []);
    stubModelAndProvider();
    // 通过 setConfig 注入 langfuse 配置，避免写全局 process.env 污染并行测试
    setConfig({ langfusePublicKey: undefined, langfuseSecretKey: undefined, langfuseBaseUrl: undefined });
  });

  // 主服务配置了 langfuse 时，应统一透传到 launchSpec.env 供 machine 上 agent 消费
  test("主服务配置 langfuse 时透传到 launchSpec.env", async () => {
    setConfig({
      langfusePublicKey: "pk-lf-demo",
      langfuseSecretKey: "sk-lf-demo",
      langfuseBaseUrl: "https://langfuse.example.com",
    });

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig(),
      environmentSecret: "secret",
    });

    expect(spec.env).toMatchObject({
      LANGFUSE_PUBLIC_KEY: "pk-lf-demo",
      LANGFUSE_SECRET_KEY: "sk-lf-demo",
      LANGFUSE_BASE_URL: "https://langfuse.example.com",
    });
  });

  // 主服务未配置 langfuse 时不应注入任何键，避免空值进入 launchSpec.env
  test("未配置 langfuse 时不注入", async () => {
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig(),
      environmentSecret: "secret",
    });

    expect(spec.env).not.toHaveProperty("LANGFUSE_PUBLIC_KEY");
    expect(spec.env).not.toHaveProperty("LANGFUSE_SECRET_KEY");
    expect(spec.env).not.toHaveProperty("LANGFUSE_BASE_URL");
  });

  // 调用方显式传入的 extraEnv 同名变量应覆盖主服务透传值（最高优先级）
  test("extraEnv 中同名 LANGFUSE_* 优先", async () => {
    setConfig({ langfusePublicKey: "pk-main", langfuseSecretKey: "sk-main" });

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig(),
      environmentSecret: "secret",
      extraEnv: { LANGFUSE_PUBLIC_KEY: "pk-extra" },
    });

    const env = spec.env ?? {};
    expect(env.LANGFUSE_PUBLIC_KEY).toBe("pk-extra");
    expect(env.LANGFUSE_SECRET_KEY).toBe("sk-main");
  });

  // 动态 LANGFUSE_USER_ID 经 extraEnv 注入（orchestration-instance 的 platformEnv
  // 与 USER_META_USER_ID 同源写入），模拟实例级用户维度派发
  test("动态 LANGFUSE_USER_ID 经 extraEnv 注入", async () => {
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentConfig: createAgentConfig(),
      environmentSecret: "secret",
      extraEnv: { LANGFUSE_USER_ID: "user_owner" },
    });

    expect(spec.env).toMatchObject({ LANGFUSE_USER_ID: "user_owner" });
  });
});
