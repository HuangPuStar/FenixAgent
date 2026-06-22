import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeCodeMcpConfig, ClaudeCodeSettings, InstalledSkillReference } from "./settings";

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
  mcpConfig: ClaudeCodeMcpConfig | null,
  agentPrompt?: string,
  _installedSkills: InstalledSkillReference[] = [],
): Promise<PreparedWorkspacePaths> {
  const paths = await ensureWorkspaceRuntimeDirs(workspace);

  if (Object.keys(config).length > 0) {
    await writeSettings(workspace, config);
  }

  if (mcpConfig) {
    await writeMcpConfig(workspace, mcpConfig);
  }

  if (agentPrompt) {
    await writeClaudeMd(workspace, agentPrompt);
  }

  return paths;
}
