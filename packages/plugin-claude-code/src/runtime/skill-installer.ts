import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/**
 * 清空 workspace 中已安装的所有 skill 目录，prepare 阶段再按当前 launchSpec 全量重建。
 */
async function clearInstalledSkills(skillsDir: string): Promise<void> {
  const entries = await readdir(skillsDir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      await rm(join(skillsDir, entry.name), { recursive: true, force: true });
    }),
  );
}

/**
 * 下载并安装 launchSpec 中声明的 skills 到 .claude/skills/ 目录。
 */
export async function installSkills(
  workspace: string,
  skills: SkillConfig[],
  dependencies: SkillInstallerDependencies = {},
): Promise<InstalledSkillReference[]> {
  const { skillsDir } = await ensureWorkspaceRuntimeDirs(workspace);
  await clearInstalledSkills(skillsDir);

  if (skills.length === 0) {
    console.log(`[claude-code-skill-installer] 无 skills 需要安装, workspace=${workspace}`);
    return [];
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const extractArchive = dependencies.extractArchive ?? defaultExtractArchive;
  console.log(
    `[claude-code-skill-installer] 开始安装 ${skills.length} 个 skills: workspace=${workspace}, skillsDir=${skillsDir}`,
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "claude-code-skills-"));

  try {
    const installed: InstalledSkillReference[] = [];

    for (const skill of skills) {
      const archivePath = join(tempRoot, `${skill.name}.zip`);
      const targetDir = join(skillsDir, skill.name);

      console.log(`[claude-code-skill-installer] 下载 skill "${skill.name}"`);
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
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
      await extractArchive(archivePath, targetDir);
      console.log(`[claude-code-skill-installer] 解压 skill "${skill.name}" 完成: targetDir=${targetDir}`);

      installed.push({
        name: skill.name,
        path: targetDir,
      });
    }

    console.log(`[claude-code-skill-installer] 全部 skills 安装完成: 共 ${installed.length} 个`);
    return installed;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
