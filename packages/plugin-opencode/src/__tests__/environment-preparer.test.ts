import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import {
  ensureWorkspaceRuntimeDirs,
  prepareWorkspaceEnvironment,
  writeOpencodeConfig,
} from "../runtime/environment-preparer";
import { buildOpencodeRuntimeConfig } from "../runtime/runtime-config";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-opencode-env-"));
}

function createLaunchSpec(): AgentLaunchSpec {
  return {
    workspace: "/tmp/workspace",
    env: {
      OPENAI_API_KEY: "sk-test",
      ACP_RCS_TOKEN: "rcs-secret",
    },
    agent: {
      name: "general",
      prompt: "You are helpful",
    },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4.1",
      modelName: "gpt-4.1",
    },
    skills: [],
    mcpServers: [
      {
        name: "local-server",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        cwd: "/tmp/mcp",
        env: { GITHUB_TOKEN: "gh-token" },
        timeout: 5000,
      },
      {
        name: "remote-server",
        type: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
        timeout: 2000,
      },
    ],
  };
}

describe("environment-preparer", () => {
  // 写入 opencode.json
  test("writes .opencode/opencode.json with mapped fields", async () => {
    const workspace = await createWorkspace();
    try {
      const config = buildOpencodeRuntimeConfig(createLaunchSpec(), [
        {
          name: "code-review",
          path: join(workspace, ".opencode", "skills", "code-review"),
        },
      ]);

      const configPath = await writeOpencodeConfig(workspace, config);
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw);

      expect(parsed.$schema).toBe("https://opencode.ai/config.json");
      expect(parsed.default_agent).toBe("general");
      expect(parsed.enabled_providers).toEqual(["openai"]);
      expect(parsed.agent.general.prompt).toBe("You are helpful");
      expect(parsed.agent.general.model).toBe("openai/gpt-4.1");
      expect(parsed.model).toBe("openai/gpt-4.1");
      expect(parsed.provider.openai.npm).toBe("@ai-sdk/openai-compatible");
      expect(parsed.provider.openai.options.baseURL).toBe("https://api.openai.com/v1");
      expect(parsed.provider.openai.models["gpt-4.1"].name).toBe("gpt-4.1");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 准备运行目录（不再写 .env 文件）
  test("prepares runtime directories without touching .env", async () => {
    const workspace = await createWorkspace();
    try {
      const paths = await ensureWorkspaceRuntimeDirs(workspace);
      const config = buildOpencodeRuntimeConfig(createLaunchSpec(), [
        { name: "writer", path: join(paths.skillsDir, "writer") },
      ]);

      await prepareWorkspaceEnvironment(workspace, config, { TEST_KEY: "test" }, [
        { name: "writer", path: join(paths.skillsDir, "writer") },
      ]);

      expect(Bun.file(paths.runtimeDir).size).toBeGreaterThanOrEqual(0);
      expect(Bun.file(paths.skillsDir).size).toBeGreaterThanOrEqual(0);
      expect((await Bun.file(paths.configPath).text()).length).toBeGreaterThan(0);
      // .env 不应被创建
      const envExists = await Bun.file(join(workspace, ".env")).exists();
      expect(envExists).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // MCP/agent/model 映射
  test("maps stdio and streamable-http MCP servers into opencode runtime config", () => {
    const config = buildOpencodeRuntimeConfig(createLaunchSpec(), []);

    expect(config.mcp["local-server"]).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      cwd: "/tmp/mcp",
      environment: { GITHUB_TOKEN: "gh-token" },
      timeout: 5000,
    });
    expect(config.mcp["remote-server"]).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
      timeout: 2000,
    });
  });
});

describe("buildOpencodeRuntimeConfig model limit 下发", () => {
  function createModelLaunchSpec(overrides: {
    protocol?: "openai" | "anthropic";
    provider?: string;
    limitConfig?: { context: number; output: number; rpm?: number } | null;
  }): AgentLaunchSpec {
    const base = createLaunchSpec();
    const provider = overrides.provider ?? overrides.protocol ?? "openai";
    return {
      ...base,
      model: {
        ...base.model,
        provider,
        protocol: overrides.protocol ?? "openai",
        ...(overrides.limitConfig !== undefined ? { limitConfig: overrides.limitConfig } : {}),
      },
    };
  }

  // context > output 时正常下发 limit
  test("context 大于 output 时下发 limit 配置", () => {
    const config = buildOpencodeRuntimeConfig(
      createModelLaunchSpec({ limitConfig: { context: 128000, output: 8000 } }),
      [],
    );
    expect(config.provider.openai.models["gpt-4.1"].limit).toEqual({ context: 128000, output: 8000 });
  });

  // context <= output 时 OpenCode 会令可用上下文归零卡死 agent，必须跳过 limit
  test("context 不大于 output 时跳过 limit，避免 usable 归零卡死", () => {
    const equalConfig = buildOpencodeRuntimeConfig(
      createModelLaunchSpec({ limitConfig: { context: 10000, output: 10000 } }),
      [],
    );
    expect(equalConfig.provider.openai.models["gpt-4.1"].limit).toBeUndefined();

    const invertedConfig = buildOpencodeRuntimeConfig(
      createModelLaunchSpec({ limitConfig: { context: 5000, output: 10000 } }),
      [],
    );
    expect(invertedConfig.provider.openai.models["gpt-4.1"].limit).toBeUndefined();
  });

  // limit 任一值缺失或 <= 0 时跳过
  test("limit context 或 output 缺失/非正时跳过", () => {
    const missingOutput = buildOpencodeRuntimeConfig(
      createModelLaunchSpec({ limitConfig: { context: 128000, output: 0 } }),
      [],
    );
    expect(missingOutput.provider.openai.models["gpt-4.1"].limit).toBeUndefined();
  });
});
