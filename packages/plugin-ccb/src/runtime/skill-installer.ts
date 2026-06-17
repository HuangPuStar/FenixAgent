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
 * 根据 RCS_URL 环境变量替换下载 URL 的 origin。
 *
 * RCS_URL 是 WebSocket 地址（ws:// 或 wss://），
 * 转换为对应的 HTTP 协议后替换原始 URL 的 origin 部分。
 * 未设置 RCS_URL 时维持原样。
 */
function resolveDownloadUrl(originalUrl: string): string {
  const rcsUrl = process.env.RCS_URL;
  if (!rcsUrl) return originalUrl;

  // ws://host:port → http://host:port  /  wss://host:port → https://host:port
  const httpUrl = rcsUrl.replace(/^ws(s?):\/\//, "http$1://");
  const base = new URL(httpUrl);
  const original = new URL(originalUrl);

  return `${base.origin}${original.pathname}${original.search}`;
}

/**
 * 下载并安装 launchSpec 中声明的 skills 到 .claude/skills/ 目录。
 */
export async function installSkills(
  workspace: string,
  skills: SkillConfig[],
  dependencies: SkillInstallerDependencies = {},
): Promise<InstalledSkillReference[]> {
  if (skills.length === 0) {
    console.log(`[ccb-skill-installer] 无 skills 需要安装, workspace=${workspace}`);
    await ensureWorkspaceRuntimeDirs(workspace);
    return [];
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const extractArchive = dependencies.extractArchive ?? defaultExtractArchive;
  const { skillsDir } = await ensureWorkspaceRuntimeDirs(workspace);
  console.log(
    `[ccb-skill-installer] 开始安装 ${skills.length} 个 skills: workspace=${workspace}, skillsDir=${skillsDir}`,
  );
  const tempRoot = await mkdtemp(join(tmpdir(), "ccb-skills-"));

  try {
    const installed: InstalledSkillReference[] = [];

    for (const skill of skills) {
      const archivePath = join(tempRoot, `${skill.name}.zip`);
      const targetDir = join(skillsDir, skill.name);

      const downloadUrl = resolveDownloadUrl(skill.url);
      console.log(`[ccb-skill-installer] 下载 skill "${skill.name}": url=${downloadUrl.slice(0, 120)}...`);
      await rm(targetDir, { recursive: true, force: true });
      await mkdir(targetDir, { recursive: true });
      await mkdir(dirname(archivePath), { recursive: true });

      const response = await fetchImpl(downloadUrl);
      if (!response.ok) {
        console.error(
          `[ccb-skill-installer] 下载 skill "${skill.name}" 失败: status=${response.status} ${response.statusText}`,
        );
        throw new Error(`Failed to download skill '${skill.name}': ${response.status} ${response.statusText}`);
      }

      const archiveBuffer = Buffer.from(await response.arrayBuffer());
      console.log(`[ccb-skill-installer] 下载 skill "${skill.name}" 成功: 大小=${archiveBuffer.length} bytes`);
      await writeFile(archivePath, archiveBuffer);
      await extractArchive(archivePath, targetDir);
      console.log(`[ccb-skill-installer] 解压 skill "${skill.name}" 完成: targetDir=${targetDir}`);

      installed.push({
        name: skill.name,
        path: targetDir,
      });
    }

    console.log(`[ccb-skill-installer] 全部 skills 安装完成: 共 ${installed.length} 个`);
    return installed;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
