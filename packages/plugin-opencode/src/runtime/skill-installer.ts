import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SkillConfig } from "@fenix/plugin-sdk";
import { ensureWorkspaceRuntimeDirs } from "./environment-preparer";
import type { InstalledSkillReference } from "./runtime-config";

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
 * 下载并安装 launchSpec 中声明的 skills。
 */
export async function installSkills(
  workspace: string,
  skills: SkillConfig[],
  dependencies: SkillInstallerDependencies = {},
): Promise<InstalledSkillReference[]> {
  if (skills.length === 0) {
    console.log(`[skill-installer] 无 skills 需要安装, workspace=${workspace}`);
    await ensureWorkspaceRuntimeDirs(workspace);
    return [];
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const extractArchive = dependencies.extractArchive ?? defaultExtractArchive;
  const { skillsDir } = await ensureWorkspaceRuntimeDirs(workspace);
  console.log(
    `[skill-installer] 开始安装 ${skills.length} 个 skills: workspace=${workspace}, skillsDir=${skillsDir}, skill 列表=[${skills.map((s) => `${s.name}(${s.url.slice(0, 80)}...)`).join(", ")}]`,
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "plugin-opencode-skills-"));

  try {
    const installed: InstalledSkillReference[] = [];

    for (const skill of skills) {
      const archivePath = join(tempRoot, `${skill.name}.zip`);
      const targetDir = join(skillsDir, skill.name);

      console.log(`[skill-installer] 下载 skill "${skill.name}": url=${skill.url.slice(0, 120)}...`);
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(dirname(archivePath), { recursive: true });

      const response = await fetchImpl(skill.url);
      if (!response.ok) {
        console.error(
          `[skill-installer] 下载 skill "${skill.name}" 失败: status=${response.status} ${response.statusText}, url=${skill.url}`,
        );
        throw new Error(`Failed to download skill '${skill.name}': ${response.status} ${response.statusText}`);
      }

      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      console.log(`[skill-installer] 下载 skill "${skill.name}" 成功: 大小=${archiveBuffer.length} bytes`);
      await writeFile(archivePath, archiveBuffer);
      await extractArchive(archivePath, targetDir);
      console.log(`[skill-installer] 解压 skill "${skill.name}" 完成: targetDir=${targetDir}`);

      installed.push({
        name: skill.name,
        path: targetDir,
      });
    }

    console.log(`[skill-installer] 全部 skills 安装完成: 共 ${installed.length} 个`);
    return installed;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
