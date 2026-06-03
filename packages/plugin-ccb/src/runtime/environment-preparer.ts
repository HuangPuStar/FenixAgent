import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CcbRuntimeConfig, InstalledSkillReference } from "./runtime-config";

export const CCB_DIR_NAME = ".claude";
export const CCB_CONFIG_FILENAME = "settings.json";

export interface PreparedWorkspacePaths {
  runtimeDir: string;
  configPath: string;
}

/**
 * 准备 .claude 目录。
 */
export async function ensureWorkspaceRuntimeDirs(workspace: string): Promise<PreparedWorkspacePaths> {
  const runtimeDir = join(workspace, CCB_DIR_NAME);
  await mkdir(runtimeDir, { recursive: true });
  const configPath = join(runtimeDir, CCB_CONFIG_FILENAME);
  return { runtimeDir, configPath };
}

/**
 * 写入 settings.json。
 */
export async function writeCcbConfig(workspace: string, config: CcbRuntimeConfig): Promise<string> {
  const { configPath } = await ensureWorkspaceRuntimeDirs(workspace);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 统一执行 workspace 环境物化。
 */
export async function prepareWorkspaceEnvironment(
  workspace: string,
  config: CcbRuntimeConfig,
  _env: Record<string, string>,
  _installedSkills: InstalledSkillReference[],
): Promise<PreparedWorkspacePaths> {
  const paths = await ensureWorkspaceRuntimeDirs(workspace);
  if (Object.keys(config).length > 0) {
    await writeCcbConfig(workspace, config);
  }
  return paths;
}
