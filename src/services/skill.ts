import { readdir, readFile, writeFile, mkdir, rename, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OLD_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");
export const SKILLS_DIR = join(homedir(), ".agents", "skills");
const DISABLED_DIR = join(SKILLS_DIR, "_disabled");

export interface SkillMeta {
  name: string;
  description: string;
  [key: string]: string;
}

export interface SkillInfo {
  name: string;
  enabled: boolean;
  description: string;
  path: string;
}

export interface SkillDetail {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  path: string;
  metadata: Record<string, string>;
}

async function ensureDisabledDir(): Promise<void> {
  if (!existsSync(DISABLED_DIR)) {
    await mkdir(DISABLED_DIR, { recursive: true });
  }
}

export async function migrateSkillsDir(): Promise<void> {
  const MIGRATED_MARKER = join(OLD_SKILLS_DIR, ".migrated");

  // 新目录已存在 → 跳过迁移（可能是全新安装或已迁移完成）
  if (existsSync(SKILLS_DIR)) return;
  // 旧目录不存在 → 跳过迁移（全新安装，无旧数据），但确保新目录存在
  if (!existsSync(OLD_SKILLS_DIR)) {
    await mkdir(SKILLS_DIR, { recursive: true });
    return;
  }
  // 已有 .migrated 标记 → 跳过（历史迁移完成，新目录被手动删除的场景）
  if (existsSync(MIGRATED_MARKER)) return;

  await mkdir(join(homedir(), ".agents"), { recursive: true });

  try {
    // 尝试原子 rename（同文件系统下生效）
    await rename(OLD_SKILLS_DIR, SKILLS_DIR);
  } catch {
    // 跨文件系统时回退到 copy + delete
    await cp(OLD_SKILLS_DIR, SKILLS_DIR, { recursive: true });
    await rm(OLD_SKILLS_DIR, { recursive: true, force: true });
  }

  // 在旧路径创建 .migrated 标记文件，防止重复迁移
  await mkdir(OLD_SKILLS_DIR, { recursive: true });
  await writeFile(MIGRATED_MARKER, new Date().toISOString(), "utf-8");

  console.log("[RCS] Skills directory migrated:", OLD_SKILLS_DIR, "→", SKILLS_DIR);
}

function parseFrontmatter(raw: string): { metadata: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { metadata: {}, content: raw };
  const metadata: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { metadata, content: match[2] };
}

function buildSkillMd(name: string, description: string, content: string, metadata?: Record<string, string>): string {
  const meta: Record<string, string> = { name, description, ...(metadata ?? {}) };
  const frontmatter = Object.entries(meta).map(([k, v]) => `${k}: "${v}"`).join("\n");
  return `---\n${frontmatter}\n---\n${content}`;
}

export async function listSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  // 扫描已启用的 skills
  if (existsSync(SKILLS_DIR)) {
    for (const entry of await readdir(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "_disabled") continue;
      const mdPath = join(SKILLS_DIR, entry.name, "SKILL.md");
      if (!existsSync(mdPath)) continue;
      const raw = await readFile(mdPath, "utf-8");
      const { metadata } = parseFrontmatter(raw);
      skills.push({ name: entry.name, enabled: true, description: metadata.description ?? "", path: mdPath });
    }
  }
  // 扫描已禁用的 skills
  if (existsSync(DISABLED_DIR)) {
    for (const entry of await readdir(DISABLED_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "_disabled") {
        const mdPath = join(DISABLED_DIR, entry.name, "SKILL.md");
        if (!existsSync(mdPath)) continue;
        const raw = await readFile(mdPath, "utf-8");
        const { metadata } = parseFrontmatter(raw);
        skills.push({ name: entry.name, enabled: false, description: metadata.description ?? "", path: mdPath });
      }
    }
  }
  return skills;
}

export async function getSkill(name: string): Promise<SkillDetail | null> {
  // 在 skills/ 中查找
  const enabledPath = join(SKILLS_DIR, name, "SKILL.md");
  const disabledPath = join(DISABLED_DIR, name, "SKILL.md");
  const filePath = existsSync(enabledPath) ? enabledPath : existsSync(disabledPath) ? disabledPath : null;
  if (!filePath) return null;
  const raw = await readFile(filePath, "utf-8");
  const { metadata, content } = parseFrontmatter(raw);
  return {
    name,
    description: metadata.description ?? "",
    content,
    enabled: filePath === enabledPath,
    path: filePath,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([k]) => k !== "name" && k !== "description")),
  };
}

export async function setSkill(name: string, data: { description: string; content: string; metadata?: Record<string, string> }): Promise<SkillInfo> {
  // 先删除旧位置（禁用目录中也检查）
  await deleteSkillInternal(name);
  // 写入 skills/name/SKILL.md
  const skillDir = join(SKILLS_DIR, name);
  await mkdir(skillDir, { recursive: true });
  const mdContent = buildSkillMd(name, data.description, data.content, data.metadata);
  await writeFile(join(skillDir, "SKILL.md"), mdContent, "utf-8");
  return { name, enabled: true, description: data.description, path: join(skillDir, "SKILL.md") };
}

export async function deleteSkill(name: string): Promise<boolean> {
  return deleteSkillInternal(name);
}

/** 内部删除实现，也供 setSkill 复用 */
async function deleteSkillInternal(name: string): Promise<boolean> {
  const enabledDir = join(SKILLS_DIR, name);
  const disabledDirPath = join(DISABLED_DIR, name);
  let deleted = false;
  if (existsSync(enabledDir)) { await rm(enabledDir, { recursive: true, force: true }); deleted = true; }
  if (existsSync(disabledDirPath)) { await rm(disabledDirPath, { recursive: true, force: true }); deleted = true; }
  return deleted;
}

export async function enableSkill(name: string): Promise<boolean> {
  const from = join(DISABLED_DIR, name);
  const to = join(SKILLS_DIR, name);
  if (!existsSync(from)) return false;
  await rename(from, to);
  return true;
}

export async function disableSkill(name: string): Promise<boolean> {
  await ensureDisabledDir();
  const from = join(SKILLS_DIR, name);
  const to = join(DISABLED_DIR, name);
  if (!existsSync(from)) return false;
  await rename(from, to);
  return true;
}
