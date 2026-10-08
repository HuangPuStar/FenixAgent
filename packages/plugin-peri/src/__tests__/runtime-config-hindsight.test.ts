import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { buildPeriRuntimeConfig } from "../runtime/runtime-config";

function spec(): AgentLaunchSpec {
  return {
    organizationId: "org",
    userId: "user",
    agent: { name: "test" },
    model: { provider: "test", protocol: "openai", baseUrl: "", apiKey: "", model: "test" },
    skills: [],
    mcpServers: [],
  };
}

describe("peri 显式插件启用", () => {
  // 启用信号与配置值分离，无 env 也必须映射镜像市场别名。
  test("plugins 启用 hindsight", () => {
    expect(buildPeriRuntimeConfig({ ...spec(), plugins: ["hindsight"] }, []).enabledPlugins).toEqual({
      "hindsight-memory@hindsight-plugin": true,
    });
  });
  // 定位信号不是启用开关，防止旧环境遗留误开记忆。
  test("只有定位 env 不启用插件", () => {
    const config = buildPeriRuntimeConfig(
      { ...spec(), env: { HINDSIGHT_CONFIG: "/workspace/.hindsight/workspace.json" } },
      [],
    );
    expect(config.enabledPlugins).toBeUndefined();
    expect(config.env?.HINDSIGHT_CONFIG).toBe("/workspace/.hindsight/workspace.json");
  });
  // 未配置插件时保持原有模型配置路径。
  test("无插件配置不生成 enabledPlugins", () => {
    expect(buildPeriRuntimeConfig(spec(), []).enabledPlugins).toBeUndefined();
  });
});
