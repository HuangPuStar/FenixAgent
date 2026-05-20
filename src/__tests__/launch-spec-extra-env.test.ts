import { describe, expect, test } from "bun:test";
import { type BuildLaunchSpecInput, buildLaunchSpec } from "../services/launch-spec-builder";

describe("buildLaunchSpec extraEnv", () => {
  // extraEnv 应合并到 AgentLaunchSpec.env
  test("extraEnv 合并到返回的 AgentLaunchSpec.env", async () => {
    const input: BuildLaunchSpecInput = {
      workspacePath: "/tmp/test",
      agentName: "test-agent",
      agentConfigId: null,
      agentPrompt: null,
      modelRef: null,
      fullConfig: {
        providers: [{ name: "openai", baseUrl: "", apiKey: "", npm: null }],
        mcpServers: [],
        agentConfig: null,
        skills: [],
      } as any,
      environmentSecret: "secret123",
      extraEnv: { USER_META_API_KEY: "rcs_test_key_123" },
    };

    const spec = await buildLaunchSpec(input);
    expect(spec.env).toBeDefined();
    expect(spec.env!.USER_META_API_KEY).toBe("rcs_test_key_123");
  });

  // 无 extraEnv 时 env 为 undefined
  test("无 extraEnv 时 AgentLaunchSpec.env 为 undefined", async () => {
    const input: BuildLaunchSpecInput = {
      workspacePath: "/tmp/test",
      agentName: "test-agent",
      agentConfigId: null,
      agentPrompt: null,
      modelRef: null,
      fullConfig: {
        providers: [{ name: "openai", baseUrl: "", apiKey: "", npm: null }],
        mcpServers: [],
        agentConfig: null,
        skills: [],
      } as any,
      environmentSecret: "secret123",
    };

    const spec = await buildLaunchSpec(input);
    expect(spec.env).toBeUndefined();
  });
});
