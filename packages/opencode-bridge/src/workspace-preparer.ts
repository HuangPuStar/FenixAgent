import { join } from "node:path";
import {
  buildOpencodeRuntimeConfig,
  type InstalledSkillReference,
  installSkills,
  type OpencodeRuntimeConfig,
  writeOpencodeConfig,
} from "@fenix/opencode";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

/** workspace 准备结果 */
export interface PreparedWorkspace {
  workspace: string;
  runtimeConfig: OpencodeRuntimeConfig;
  installedSkills: InstalledSkillReference[];
}

/**
 * 解析 workspace 路径。
 * 逻辑与 instance-manager.ts 的 resolveWorkspace 一致。
 */
export function resolveWorkspace(workspaceRoot: string, launchSpec: AgentLaunchSpec): string {
  if (launchSpec.environmentId) {
    return join(workspaceRoot, launchSpec.organizationId, launchSpec.userId, launchSpec.environmentId);
  }
  return join(workspaceRoot, launchSpec.organizationId, launchSpec.userId);
}

/**
 * opencode workspace 环境准备：
 * 1. resolveWorkspace → 计算路径
 * 2. installSkills → 安装技能
 * 3. buildOpencodeRuntimeConfig → 构建配置
 * 4. writeOpencodeConfig → 写入 .opencode/opencode.json
 */
export async function prepareWorkspace(workspaceRoot: string, launchSpec: AgentLaunchSpec): Promise<PreparedWorkspace> {
  const workspace = resolveWorkspace(workspaceRoot, launchSpec);
  const installedSkills = await installSkills(workspace, launchSpec.skills);
  const runtimeConfig = buildOpencodeRuntimeConfig(launchSpec, installedSkills);
  await writeOpencodeConfig(workspace, runtimeConfig);
  return { workspace, runtimeConfig, installedSkills };
}
