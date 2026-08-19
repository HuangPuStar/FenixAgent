import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SkillConfig } from "@fenix/plugin-sdk";
import { ensureWorkspaceRuntimeDirs } from "./environment";
import type { InstalledSkillReference } from "./settings";

const execFileAsync = promisify(execFile);

export interface SkillInstallerDependencies {
  fetch?: typeof fetch;
  extractArchive?: (archivePath: string, targetDir: string) => Promise<void>;
}

async function defaultExtractArchive(archivePath: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await execFileAsync("unzip", ["-oq", archivePath, "-d", targetDir]);
}

async function replaceInstalledSkills(skillsDir: string, stagedSkillsDir: string): Promise<void> {
  const backupDir = `${skillsDir}.backup-${randomUUID()}`;
  await rename(skillsDir, backupDir);
  try {
    await rename(stagedSkillsDir, skillsDir);
    await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await rm(skillsDir, { recursive: true, force: true });
    await rename(backupDir, skillsDir).catch(() => {});
    throw error;
  }
}

/**
 * 下载并安装 launchSpec 中声明的 skills 到 .claude/skills/ 目录。
 * 所有归档先在临时目录完成解压，再整体替换线上目录；下载或解压失败时保留旧 Skills。
 */
export async function installSkills(
  workspace: string,
  skills: SkillConfig[],
  dependencies: SkillInstallerDependencies = {},
): Promise<InstalledSkillReference[]> {
  const { skillsDir } = await ensureWorkspaceRuntimeDirs(workspace);
  const fetchImpl = dependencies.fetch ?? fetch;
  const extractArchive = dependencies.extractArchive ?? defaultExtractArchive;
  // 暂存目录必须与 .claude/skills 同属 workspace 文件系统，目录替换才能安全使用 rename。
  const tempRoot = await mkdtemp(join(dirname(skillsDir), ".claude-code-skills-"));
  const stagedSkillsDir = join(tempRoot, "skills");
  await mkdir(stagedSkillsDir, { recursive: true });

  if (skills.length === 0) {
    try {
      await replaceInstalledSkills(skillsDir, stagedSkillsDir);
      console.log(`[claude-code-skill-installer] 无 skills 需要安装, workspace=${workspace}`);
      return [];
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  console.log(
    `[claude-code-skill-installer] 开始安装 ${skills.length} 个 skills: workspace=${workspace}, skillsDir=${skillsDir}`,
  );

  try {
    const installed: InstalledSkillReference[] = [];

    for (const skill of skills) {
      const archivePath = join(tempRoot, `${skill.name}.zip`);
      const stagedTargetDir = join(stagedSkillsDir, skill.name);
      const installedTargetDir = join(skillsDir, skill.name);

      console.log(`[claude-code-skill-installer] 下载 skill "${skill.name}"`);
      await mkdir(stagedTargetDir, { recursive: true });
      await mkdir(dirname(archivePath), { recursive: true });

      const response = await fetchImpl(skill.url);
      if (!response.ok) {
        console.error(
          `[claude-code-skill-installer] 下载 skill "${skill.name}" 失败: status=${response.status} ${response.statusText}`,
        );
        throw new Error(`Failed to download skill '${skill.name}': ${response.status} ${response.statusText}`);
      }

      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      console.log(`[claude-code-skill-installer] 下载 skill "${skill.name}" 成功: 大小=${archiveBuffer.length} bytes`);
      await writeFile(archivePath, archiveBuffer);
      await extractArchive(archivePath, stagedTargetDir);
      console.log(`[claude-code-skill-installer] 解压 skill "${skill.name}" 完成: targetDir=${installedTargetDir}`);

      installed.push({
        name: skill.name,
        path: installedTargetDir,
      });
    }

    await replaceInstalledSkills(skillsDir, stagedSkillsDir);
    console.log(`[claude-code-skill-installer] 全部 skills 安装完成: 共 ${installed.length} 个`);
    return installed;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
