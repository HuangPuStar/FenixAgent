import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { buildCcbRuntimeConfig } from "../runtime/runtime-config";

function makeLaunchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "org-1",
    userId: "user-1",
    env: {},
    agent: { name: "test-agent", prompt: "You are helpful." },
    model: {
      provider: "test-provider",
      protocol: "openai",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "test-model",
    },
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

describe("buildCcbRuntimeConfig — Hindsight", () => {
  // launchSpec.env 包含 HINDSIGHT_API_URL → 生成 enabledPlugins
  test("HINDSIGHT_API_URL 存在时生成 enabledPlugins", () => {
    const spec = makeLaunchSpec({
      env: {
        HINDSIGHT_API_URL: "http://hindsight:9999",
        HINDSIGHT_BANK_ID: "bank-123",
        HINDSIGHT_LLM_PROVIDER: "claude-code",
      },
    });
    const config = buildCcbRuntimeConfig(spec, []);
    expect(config.enabledPlugins).toEqual({ "hindsight-memory@hindsight": true });
    // 环境变量应透传到 config.env
    expect(config.env?.HINDSIGHT_API_URL).toBe("http://hindsight:9999");
    expect(config.env?.HINDSIGHT_BANK_ID).toBe("bank-123");
  });

  // launchSpec.env 不含 HINDSIGHT_API_URL → 不生成 enabledPlugins
  test("无 HINDSIGHT_API_URL 时不生成 enabledPlugins", () => {
    const spec = makeLaunchSpec({ env: { SOME_OTHER: "value" } });
    const config = buildCcbRuntimeConfig(spec, []);
    expect(config.enabledPlugins).toBeUndefined();
  });

  // env 为 undefined → 不报错
  test("env 为 undefined 时不报错且不生成 enabledPlugins", () => {
    const spec = makeLaunchSpec();
    spec.env = undefined as unknown as Record<string, string>;
    const config = buildCcbRuntimeConfig(spec, []);
    expect(config.enabledPlugins).toBeUndefined();
  });

  // HINDSIGHT_API_TOKEN 透传
  test("HINDSIGHT_API_TOKEN 透传到 config.env", () => {
    const spec = makeLaunchSpec({
      env: {
        HINDSIGHT_API_URL: "http://hindsight:9999",
        HINDSIGHT_API_TOKEN: "token-xyz",
      },
    });
    const config = buildCcbRuntimeConfig(spec, []);
    expect(config.env?.HINDSIGHT_API_TOKEN).toBe("token-xyz");
  });

  // model env 与 Hindsight env 共存
  test("model env 与 Hindsight env 共存不冲突", () => {
    const spec = makeLaunchSpec({
      env: {
        HINDSIGHT_API_URL: "http://hindsight:9999",
        HINDSIGHT_BANK_ID: "bank-123",
      },
    });
    const config = buildCcbRuntimeConfig(spec, []);
    expect(config.enabledPlugins).toEqual({ "hindsight-memory@hindsight": true });
    // model 配置的 OPENAI_API_KEY 仍然存在
    expect(config.env?.OPENAI_API_KEY).toBe("sk-test");
    expect(config.env?.HINDSIGHT_API_URL).toBe("http://hindsight:9999");
  });
});
