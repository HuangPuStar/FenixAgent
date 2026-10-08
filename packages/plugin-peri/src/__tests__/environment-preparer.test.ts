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

  // 取消全部 MCP 后，复用 workspace 里的旧 .mcp.json 必须被改写为空集合，否则 agent 继续加载已取消的 server
  test("MCP 绑定清空后 .mcp.json 被全量重写为空集合", async () => {
    const workspace = await createWorkspace();
    try {
      const launchSpec = createLaunchSpec();
      const runtimeConfig = buildPeriRuntimeConfig(launchSpec, []);

      await prepareWorkspaceEnvironment(
        workspace,
        runtimeConfig,
        buildPeriMcpConfig(launchSpec),
        launchSpec.agent.prompt,
        [],
      );
      const before = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(before.mcpServers)).toEqual(["local-server", "remote-server"]);

      await prepareWorkspaceEnvironment(
        workspace,
        runtimeConfig,
        buildPeriMcpConfig({ ...launchSpec, mcpServers: [] }),
        [],
      );

      const after = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(after.mcpServers).toEqual({});
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 空 MCP 集合仍需落盘（写空 mcpServers），只有缺失的 prompt 不产生文件，避免留下无内容的 CLAUDE.md
  test("无 MCP 与 prompt 时空集合落盘且不写 CLAUDE.md", async () => {
    const workspace = await createWorkspace();
    try {
      const launchSpec = createLaunchSpec();
      const runtimeConfig = buildPeriRuntimeConfig(launchSpec, []);

      await prepareWorkspaceEnvironment(
        workspace,
        runtimeConfig,
        buildPeriMcpConfig({ ...launchSpec, mcpServers: [] }),
      );

      const mcp = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcp.mcpServers).toEqual({});
      expect(await Bun.file(join(workspace, "CLAUDE.md")).exists()).toBe(false);
      expect(await Bun.file(join(workspace, ".claude", "settings.local.json")).exists()).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
