import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentLaunchSpec, bindWorkspaceFiles, writeWorkspaceFiles } from "@fenix/plugin-sdk";

import type { InstalledSkillReference, OpencodeRuntimeConfig } from "./runtime-config";

/** 本地与 machine 共用的启动文件物化边界，配置转换前完成全量重写。 */
export async function prepareLaunchWorkspace(workspace: string, spec: AgentLaunchSpec): Promise<AgentLaunchSpec> {
  const bound = bindWorkspaceFiles(spec, workspace);
  await writeWorkspaceFiles(workspace, bound.workspaceFiles);
  return bound;
}

export const OPENCODE_DIR_NAME = ".opencode";
export const OPENCODE_SKILLS_DIR_NAME = "skills";
export const OPENCODE_CONFIG_FILENAME = "opencode.json";

export interface PreparedWorkspacePaths {
  runtimeDir: string;
  skillsDir: string;
  configPath: string;
}

/**
 * 准备 runtime 固定使用的目录布局。
 */
export async function ensureWorkspaceRuntimeDirs(workspace: string): Promise<PreparedWorkspacePaths> {
  const runtimeDir = join(workspace, OPENCODE_DIR_NAME);
  const skillsDir = join(runtimeDir, OPENCODE_SKILLS_DIR_NAME);
  const configPath = join(runtimeDir, OPENCODE_CONFIG_FILENAME);

  await mkdir(runtimeDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  return { runtimeDir, skillsDir, configPath };
}

/**
 * 写入 opencode runtime 配置文件。
 */
export async function writeOpencodeConfig(workspace: string, config: OpencodeRuntimeConfig): Promise<string> {
  const { configPath } = await ensureWorkspaceRuntimeDirs(workspace);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 统一执行 workspace 环境物化。
 */
export async function prepareWorkspaceEnvironment(
  workspace: string,
  config: OpencodeRuntimeConfig,
  _env: Record<string, string>,
  _installedSkills: InstalledSkillReference[],
): Promise<PreparedWorkspacePaths> {
  const paths = await ensureWorkspaceRuntimeDirs(workspace);
  await writeOpencodeConfig(workspace, config);
  return paths;
}
