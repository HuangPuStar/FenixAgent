import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledSkillReference, OpencodeRuntimeConfig } from "./runtime-config";

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
export async function writeOpencodeConfig(
  workspace: string,
  config: OpencodeRuntimeConfig,
): Promise<string> {
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
