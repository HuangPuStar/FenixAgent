import type { SkillConfig } from "@fenix/plugin-sdk";
import type { InstalledSkillReference } from "./runtime-config";

/**
 * CCB (claude --acp) 不需要安装 skill 到文件系统。
 * Claude Code 使用 .claude/commands/ 管理自定义指令，不在 spawn 时注入。
 */
export async function installSkills(_workspace: string, _skills: SkillConfig[]): Promise<InstalledSkillReference[]> {
  return [];
}
