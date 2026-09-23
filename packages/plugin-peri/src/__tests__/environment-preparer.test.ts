import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import {
  ensureWorkspaceRuntimeDirs,
  prepareWorkspaceEnvironment,
  writePeriSettings,
} from "../runtime/environment-preparer";
import { buildPeriMcpConfig, buildPeriRuntimeConfig } from "../runtime/runtime-config";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-peri-env-"));
}

function createLaunchSpec(): AgentLaunchSpec {
  return {
    organizationId: "org-1",
    userId: "user-1",
    env: {
      USER_META_USER_ID: "user-1",
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
  // peri 按 Claude Code 生态读取 skills 与 agent 定义，目录布局必须落在 .claude 下
  test("准备 .claude 目录与 skills 子目录", async () => {
    const workspace = await createWorkspace();
    try {
      const paths = await ensureWorkspaceRuntimeDirs(workspace);

      expect(paths.runtimeDir).toBe(join(workspace, ".claude"));
      expect(paths.skillsDir).toBe(join(workspace, ".claude", "skills"));
      expect(paths.configPath).toBe(join(workspace, ".claude", "settings.local.json"));
      expect((await stat(paths.skillsDir)).isDirectory()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 一次 workspace 物化要同时写出 claude 兼容配置、MCP 配置与系统 prompt
  test("写出 settings.local.json、.mcp.json 与 CLAUDE.md", async () => {
    const workspace = await createWorkspace();
    try {
      const launchSpec = createLaunchSpec();
      const runtimeConfig = buildPeriRuntimeConfig(launchSpec, []);
      const mcpConfig = buildPeriMcpConfig(launchSpec);

      await prepareWorkspaceEnvironment(workspace, runtimeConfig, mcpConfig, launchSpec.agent.prompt, []);
      await writePeriSettings(workspace, launchSpec);

      const claudeConfig = JSON.parse(await readFile(join(workspace, ".claude", "settings.local.json"), "utf8")) as {
        model: string;
        modelType: string;
        poorMode: boolean;
        env: Record<string, string>;
      };
      expect(claudeConfig.model).toBe("gpt-4.1");
      expect(claudeConfig.modelType).toBe("openai");
      expect(claudeConfig.poorMode).toBe(true);
      expect(claudeConfig.env.OPENAI_API_KEY).toBe("sk-test");

      expect(await readFile(join(workspace, "CLAUDE.md"), "utf8")).toBe("You are helpful");

      const mcp = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcp.mcpServers).toEqual({
        "local-server": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "gh-token" },
          cwd: "/tmp/mcp",
        },
        "remote-server": {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      });

      const periSettings = JSON.parse(await readFile(join(workspace, ".peri", "settings.json"), "utf8")) as {
        config: { active_alias: string };
      };
      expect(periSettings.config.active_alias).toBe("opus");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 没有 MCP server 与 agent prompt 时不应留下空配置文件，避免覆盖用户既有 workspace 内容
  test("无 MCP 与 prompt 时不写多余文件", async () => {
    const workspace = await createWorkspace();
    try {
      const launchSpec = createLaunchSpec();
      const runtimeConfig = buildPeriRuntimeConfig(launchSpec, []);

      await prepareWorkspaceEnvironment(
        workspace,
        runtimeConfig,
        buildPeriMcpConfig({ ...launchSpec, mcpServers: [] }),
      );

      expect(await Bun.file(join(workspace, ".mcp.json")).exists()).toBe(false);
      expect(await Bun.file(join(workspace, "CLAUDE.md")).exists()).toBe(false);
      expect(await Bun.file(join(workspace, ".claude", "settings.local.json")).exists()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
