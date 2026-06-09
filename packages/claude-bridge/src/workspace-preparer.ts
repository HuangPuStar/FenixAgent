import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { mapPermissionsToClaudeSettings, mapPermissionToSdkMode } from "./permission-mapper.js";

export interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
    defaultMode?: string;
  };
}

/**
 * 准备 Claude Code workspace：创建 .claude/ 目录并写入 settings.json。
 */
export async function prepareClaudeWorkspace(
  workspaceRoot: string,
  permissionMode: string,
  launchSpec: AgentLaunchSpec,
): Promise<void> {
  const workspace = launchSpec.environmentId
    ? join(workspaceRoot, launchSpec.organizationId, launchSpec.userId, launchSpec.environmentId)
    : join(workspaceRoot, launchSpec.organizationId, launchSpec.userId);

  const claudeDir = join(workspace, ".claude");
  await mkdir(claudeDir, { recursive: true });

  const settings: ClaudeSettings = {
    permissions: {
      defaultMode: mapPermissionToSdkMode(permissionMode),
      ...mapPermissionsToClaudeSettings(launchSpec),
    },
  };

  await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));
  console.log(`[claude-bridge] workspace prepared: ${workspace}`);
}
