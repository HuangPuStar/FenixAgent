import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { prepareWorkspaceEnvironment } from "../runtime/environment";
import { buildMcpConfig, buildSettings } from "../runtime/settings";

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-claude-code-env-"));
}

function createLaunchSpec(): AgentLaunchSpec {
  return {
    organizationId: "org-1",
    userId: "user-1",
    agent: { name: "general", prompt: "You are helpful" },
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
      },
      {
        name: "remote-server",
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    ],
  };
}

/** 只读回 mcpServers 字段：断言聚焦「下发集合」本身，不锁死 JSON 缩进等与语义无关的细节。 */
async function readMcpServers(workspace: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(join(workspace, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  return raw.mcpServers;
}

describe("Claude Code workspace 物化", () => {
  // 有启用中的 MCP 时 .mcp.json 记录完整清单，agent 按该文件加载工具
  test("启用中的 MCP 集合写入 .mcp.json", async () => {
    const workspace = await createWorkspace();
    try {
      const launchSpec = createLaunchSpec();

      await prepareWorkspaceEnvironment(workspace, buildSettings(launchSpec, []), buildMcpConfig(launchSpec));

      expect(await readMcpServers(workspace)).toEqual({
        "local-server": { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        "remote-server": { url: "https://example.com/mcp" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  // 取消全部 MCP 后复用 workspace 会留下旧文件，必须被覆盖为空集合而不是跳过写入
  test("MCP 绑定清空后 .mcp.json 被全量重写为空集合", async () => {
    const workspace = await createWorkspace();
    try {
      const launchSpec = createLaunchSpec();
      const settings = buildSettings(launchSpec, []);
      await prepareWorkspaceEnvironment(workspace, settings, buildMcpConfig(launchSpec));
      expect(Object.keys(await readMcpServers(workspace))).toHaveLength(2);

      await prepareWorkspaceEnvironment(workspace, settings, buildMcpConfig({ ...launchSpec, mcpServers: [] }));

      expect(await readMcpServers(workspace)).toEqual({});
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
