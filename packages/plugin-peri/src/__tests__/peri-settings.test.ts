import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { writePeriSettings } from "../runtime/environment-preparer";

function makeLaunchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "org-1",
    userId: "user-1",
    env: {
      USER_META_USER_ID: "user-1",
    },
    agent: { name: "test-agent", prompt: "You are helpful." },
    model: {
      provider: "test-provider",
      protocol: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-api-key",
      model: "test-model",
      modelName: "test-model-name",
    },
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-peri-settings-"));
}

describe("writePeriSettings", () => {
  // peri 引擎无条件写出 provider/profile 配置：任何一次 workspace 物化都必须落盘，
  // 否则 peri 进程拿不到模型鉴权参数。
  test("无条件写出 .peri/settings.json 的 provider/profile 结构", async () => {
    const workspace = await createWorkspace();

    try {
      const configPath = await writePeriSettings(workspace, makeLaunchSpec());

      expect(configPath).toBe(join(workspace, ".peri", "settings.json"));
      const settings = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

      expect(settings).toEqual({
        config: {
          active_alias: "opus",
          providers: [
            {
              id: "test-provider",
              type: "openai",
              apiKey: "test-api-key",
              baseUrl: "https://api.example.com/v1",
              name: "test-provider",
              models: {
                opus: "test-model-name",
                sonnet: "test-model-name",
                haiku: "test-model-name",
                fable: "test-model-name",
              },
            },
          ],
          profiles: {
            opus: {
              provider: "test-provider",
              model: "test-model-name",
              effort: "medium",
            },
            sonnet: {
              provider: "test-provider",
              effort: "max",
            },
            haiku: {
              provider: "test-provider",
              effort: "low",
            },
          },
          skills_dir: null,
          env: {
            USER_META_USER_ID: "user-1",
          },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 未声明运行环境变量时不得写出空 env 对象，避免覆盖 peri 全局 settings 的既有环境配置。
  test("launchSpec.env 为空时省略 env 字段", async () => {
    const workspace = await createWorkspace();

    try {
      const configPath = await writePeriSettings(workspace, makeLaunchSpec({ env: undefined }));
      const settings = JSON.parse(await readFile(configPath, "utf8")) as { config: Record<string, unknown> };

      expect(settings.config.env).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
