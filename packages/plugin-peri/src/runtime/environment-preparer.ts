import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import {
  buildPeriSettingsConfig,
  type InstalledSkillReference,
  type PeriMcpConfig,
  type PeriRuntimeConfig,
} from "./runtime-config";

export const PERI_CLAUDE_DIR_NAME = ".claude";
export const PERI_CLAUDE_SETTINGS_FILENAME = "settings.local.json";
export const PERI_SKILLS_DIR_NAME = "skills";
export const PERI_CLAUDE_MD_FILENAME = "CLAUDE.md";
export const PERI_MCP_CONFIG_FILENAME = ".mcp.json";
export const PERI_DIR_NAME = ".peri";
export const PERI_SETTINGS_FILENAME = "settings.json";

export interface PreparedWorkspacePaths {
  /** Claude 兼容目录（`.claude`），skills 与 settings.local.json 都落在这里。 */
  runtimeDir: string;
  skillsDir: string;
  configPath: string;
}

/**
 * 准备 `.claude` 目录 + skills 子目录。
 *
 * Peri 按 Claude Code 生态布局读取 skills（`.claude/skills`）与 agent 定义（`.claude/agents`），
 * 因此 workspace 物化的目录布局与 ccb 一致。
 */
export async function ensureWorkspaceRuntimeDirs(workspace: string): Promise<PreparedWorkspacePaths> {
  const runtimeDir = join(workspace, PERI_CLAUDE_DIR_NAME);
  const skillsDir = join(runtimeDir, PERI_SKILLS_DIR_NAME);
  const configPath = join(runtimeDir, PERI_CLAUDE_SETTINGS_FILENAME);

  await mkdir(runtimeDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  return { runtimeDir, skillsDir, configPath };
}

/**
 * 写入 Claude 兼容的 settings.local.json。
 */
export async function writePeriClaudeConfig(workspace: string, config: PeriRuntimeConfig): Promise<string> {
  const { configPath } = await ensureWorkspaceRuntimeDirs(workspace);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 写入 .mcp.json（项目级 MCP server 配置）。
 */
export async function writePeriMcpConfig(workspace: string, mcpConfig: PeriMcpConfig): Promise<string> {
  const configPath = join(workspace, PERI_MCP_CONFIG_FILENAME);
  await writeFile(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 写入 CLAUDE.md（系统 prompt），放在 workspace 根目录（与 .mcp.json 同级）。
 */
export async function writeClaudeMd(workspace: string, content: string): Promise<string> {
  const configPath = join(workspace, PERI_CLAUDE_MD_FILENAME);
  await writeFile(configPath, content, "utf8");
  return configPath;
}

/**
 * 写入 `.peri/settings.json`（Peri CLI 的 project 级配置：provider / profile / 运行时环境变量）。
 *
 * `.peri/settings.json` 是 peri 引擎独有的配置面，`@fenix/ccb` 不写该文件——两端配置分叉的
 * 唯一来源是 peri，改 provider/profile 结构时不需要同步 ccb 侧。
 */
export async function writePeriSettings(workspace: string, launchSpec: AgentLaunchSpec): Promise<string> {
  const periDir = join(workspace, PERI_DIR_NAME);
  await mkdir(periDir, { recursive: true });

  const configPath = join(periDir, PERI_SETTINGS_FILENAME);
  await writeFile(configPath, `${JSON.stringify(buildPeriSettingsConfig(launchSpec), null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 统一执行 workspace 环境物化：Claude 兼容配置 + MCP + 系统 prompt。
 */
export async function prepareWorkspaceEnvironment(
  workspace: string,
  config: PeriRuntimeConfig,
  mcpConfig: PeriMcpConfig | null,
  agentPrompt?: string,
  _installedSkills: InstalledSkillReference[] = [],
): Promise<PreparedWorkspacePaths> {
  const paths = await ensureWorkspaceRuntimeDirs(workspace);

  // settings.local.json
  if (Object.keys(config).length > 0) {
    await writePeriClaudeConfig(workspace, config);
  }

  // .mcp.json
  if (mcpConfig) {
    await writePeriMcpConfig(workspace, mcpConfig);
  }

  // CLAUDE.md（workspace 根目录，与 .mcp.json 同级）
  if (agentPrompt) {
    await writeClaudeMd(workspace, agentPrompt);
  }

  return paths;
}
