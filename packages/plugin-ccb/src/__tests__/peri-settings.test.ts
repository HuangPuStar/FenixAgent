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
      HINDSIGHT_API_URL: "http://hindsight:9999",
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

describe("writePeriSettings", () => {
  // Peri 节点应写入新版 profile 配置，并保留运行时下发的环境变量。
  test("writes the current Peri provider and profile settings format", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plugin-ccb-peri-"));
    const previousIsPeri = process.env.IS_PERI;
    process.env.IS_PERI = "1";

    try {
      const configPath = await writePeriSettings(workspace, makeLaunchSpec());
      const settings = JSON.parse(await readFile(configPath!, "utf8")) as Record<string, unknown>;

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
            HINDSIGHT_API_URL: "http://hindsight:9999",
            USER_META_USER_ID: "user-1",
          },
        },
      });
    } finally {
      if (previousIsPeri === undefined) {
        delete process.env.IS_PERI;
      } else {
        process.env.IS_PERI = previousIsPeri;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 非 Peri 节点不得创建额外配置，避免影响普通 CCB 运行时。
  test("does not write settings outside a Peri node", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plugin-ccb-peri-"));
    const previousIsPeri = process.env.IS_PERI;
    delete process.env.IS_PERI;

    try {
      await expect(writePeriSettings(workspace, makeLaunchSpec())).resolves.toBeNull();
    } finally {
      if (previousIsPeri === undefined) {
        delete process.env.IS_PERI;
      } else {
        process.env.IS_PERI = previousIsPeri;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
