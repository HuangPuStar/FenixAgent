import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentLaunchSpec, bindWorkspaceFiles, writeWorkspaceFiles } from "@fenix/plugin-sdk";

import type { ClaudeCodeMcpConfig, ClaudeCodeSettings, InstalledSkillReference } from "./settings";

/** 本地与 machine 共用的启动文件物化边界，配置转换前完成全量重写。 */
export async function prepareLaunchWorkspace(workspace: string, spec: AgentLaunchSpec): Promise<AgentLaunchSpec> {
  const bound = bindWorkspaceFiles(spec, workspace);
  await writeWorkspaceFiles(workspace, bound.workspaceFiles);
  return bound;
}

const CLAUDE_DIR_NAME = ".claude";
const SETTINGS_FILENAME = "settings.local.json";
const SKILLS_DIR_NAME = "skills";
const CLAUDE_MD_FILENAME = "CLAUDE.md";
const MCP_CONFIG_FILENAME = ".mcp.json";

export interface PreparedWorkspacePaths {
  runtimeDir: string;
  skillsDir: string;
  configPath: string;
}

/**
 * 准备 .claude 目录 + skills 子目录。
 */
export async function ensureWorkspaceRuntimeDirs(workspace: string): Promise<PreparedWorkspacePaths> {
  const runtimeDir = join(workspace, CLAUDE_DIR_NAME);
  const skillsDir = join(runtimeDir, SKILLS_DIR_NAME);
  const configPath = join(runtimeDir, SETTINGS_FILENAME);

  await mkdir(runtimeDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  return { runtimeDir, skillsDir, configPath };
}

/**
 * 写入 settings.local.json。
 */
export async function writeSettings(workspace: string, config: ClaudeCodeSettings): Promise<string> {
  const { configPath } = await ensureWorkspaceRuntimeDirs(workspace);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 写入 .mcp.json（项目级 MCP server 配置）。
 */
export async function writeMcpConfig(workspace: string, mcpConfig: ClaudeCodeMcpConfig): Promise<string> {
  const configPath = join(workspace, MCP_CONFIG_FILENAME);
  await writeFile(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 写入 CLAUDE.md（系统 prompt），放在 workspace 根目录。
 */
export async function writeClaudeMd(workspace: string, content: string): Promise<string> {
  const claudeMdPath = join(workspace, CLAUDE_MD_FILENAME);
  await writeFile(claudeMdPath, content, "utf8");
  return claudeMdPath;
}

/**
 * 统一执行 workspace 环境物化。
 */
export async function prepareWorkspaceEnvironment(
  workspace: string,
  config: ClaudeCodeSettings,
  mcpConfig: ClaudeCodeMcpConfig,
  agentPrompt?: string,
  _installedSkills: InstalledSkillReference[] = [],
): Promise<PreparedWorkspacePaths> {
  const paths = await ensureWorkspaceRuntimeDirs(workspace);

  if (Object.keys(config).length > 0) {
    await writeSettings(workspace, config);
  }

  // .mcp.json：每次物化全量重写（空集合写 `{"mcpServers":{}}`），不做条件跳过。
  // 复用 workspace 时旧文件仍在，只有重写才能让「取消/移除 MCP」生效，否则 agent 继续加载已取消的 server。
  await writeMcpConfig(workspace, mcpConfig);

  if (agentPrompt) {
    await writeClaudeMd(workspace, agentPrompt);
  }

  return paths;
}
