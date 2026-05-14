import { readdir, readFile, writeFile, mkdir, rm, cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import * as configPg from "./config-pg";

export const OLD_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");
export const SKILLS_DIR = join(homedir(), ".agents", "skills");

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

export interface UploadSkillFile {
  skillName: string;
  relativePath: string;
  content: string;
}

export type ImportConflictStrategy = "ignore" | "overwrite";

export interface ImportSkillsConflict {
  name: string;
  enabled: boolean;
  path: string;
}

export interface ImportSkillsResult {
  imported: SkillInfo[];
  skipped: string[];
  conflicts: ImportSkillsConflict[];
}

// --- Workspace Skill Sources ---

export type SkillSourceStatus = "online" | "offline" | "timeout";

export interface SkillSourceInfo {
  type: "global" | "workspace";
  id?: string;
  name: string;
  path: string;
  status: SkillSourceStatus;
  skills: SkillInfo[];
}

export async function migrateSkillsDir(): Promise<void> {
  const MIGRATED_MARKER = join(OLD_SKILLS_DIR, ".migrated");

  if (existsSync(SKILLS_DIR)) return;
  if (!existsSync(OLD_SKILLS_DIR)) {
    await mkdir(SKILLS_DIR, { recursive: true });
    return;
  }
  if (existsSync(MIGRATED_MARKER)) return;

  await mkdir(join(homedir(), ".agents"), { recursive: true });

  try {
    const { rename } = await import("node:fs/promises");
    await rename(OLD_SKILLS_DIR, SKILLS_DIR);
  } catch {
    await cp(OLD_SKILLS_DIR, SKILLS_DIR, { recursive: true });
    await rm(OLD_SKILLS_DIR, { recursive: true, force: true });
  }

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

function createSkillValidationError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "VALIDATION_ERROR";
  return error;
}

function normalizeUploadPath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").trim();
  if (!normalized || normalized === "." || normalized.startsWith("/")) {
    throw createSkillValidationError("上传文件路径无效");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw createSkillValidationError("上传文件路径无效");
  }

  return segments.join("/");
}

function groupUploadFiles(files: UploadSkillFile[]): Map<string, UploadSkillFile[]> {
  const grouped = new Map<string, UploadSkillFile[]>();

  for (const file of files) {
    const skillName = file.skillName.trim();
    if (!skillName) {
      throw createSkillValidationError("上传文件缺少 skill 名称");
    }
    if (skillName.includes("/") || skillName.includes("\\")) {
      throw createSkillValidationError(`Skill 名称不合法: ${skillName}`);
    }

    const normalizedPath = normalizeUploadPath(file.relativePath);
    const items = grouped.get(skillName) ?? [];
    if (items.some((item) => item.relativePath === normalizedPath)) {
      throw createSkillValidationError(`Skill "${skillName}" 包含重复文件: ${normalizedPath}`);
    }
    items.push({ ...file, skillName, relativePath: normalizedPath });
    grouped.set(skillName, items);
  }

  return grouped;
}

// ────────────────────────────────────────────
// 全局 Skill 函数（PG 元数据 + 文件系统内容）
// ────────────────────────────────────────────

function skillContentPath(name: string): string {
  return join(SKILLS_DIR, name, "SKILL.md");
}

export async function listSkills(userId: string): Promise<SkillInfo[]> {
  const rows = await configPg.listSkills(userId);
  return rows.map((r) => ({
    name: r.name,
    enabled: r.enabled,
    description: r.description ?? "",
    path: r.contentPath ?? skillContentPath(r.name),
  }));
}

export async function getSkill(userId: string, name: string): Promise<SkillDetail | null> {
  const meta = await configPg.getSkill(userId, name);
  if (!meta) return null;

  const contentPath = meta.contentPath ?? skillContentPath(name);
  let content = "";
  let fileMetadata: Record<string, string> = {};
  if (existsSync(contentPath)) {
    const raw = await readFile(contentPath, "utf-8");
    const parsed = parseFrontmatter(raw);
    content = parsed.content;
    fileMetadata = parsed.metadata;
  }

  return {
    name,
    description: meta.description ?? fileMetadata.description ?? "",
    content,
    enabled: meta.enabled,
    path: contentPath,
    metadata: Object.fromEntries(
      Object.entries(fileMetadata).filter(([k]) => k !== "name" && k !== "description"),
    ),
  };
}

export async function setSkill(
  userId: string,
  name: string,
  data: { description: string; content: string; metadata?: Record<string, string> },
): Promise<SkillInfo> {
  const contentPath = skillContentPath(name);
  const skillDir = join(SKILLS_DIR, name);
  await mkdir(skillDir, { recursive: true });
  const mdContent = buildSkillMd(name, data.description, data.content, data.metadata);
  await writeFile(contentPath, mdContent, "utf-8");

  await configPg.upsertSkill(userId, name, {
    description: data.description,
    contentPath,
    metadata: data.metadata,
    enabled: true,
  });

  return { name, enabled: true, description: data.description, path: contentPath };
}

export async function deleteSkill(userId: string, name: string): Promise<boolean> {
  const skillDir = join(SKILLS_DIR, name);
  if (existsSync(skillDir)) {
    await rm(skillDir, { recursive: true, force: true });
  }
  return configPg.deleteSkill(userId, name);
}

export async function enableSkill(userId: string, name: string): Promise<boolean> {
  return configPg.enableSkill(userId, name);
}

export async function disableSkill(userId: string, name: string): Promise<boolean> {
  return configPg.disableSkill(userId, name);
}

export async function importSkillDirectories(
  userId: string,
  files: UploadSkillFile[],
  strategy?: ImportConflictStrategy,
): Promise<ImportSkillsResult> {
  if (files.length === 0) {
    throw createSkillValidationError("未提供任何上传文件");
  }

  const grouped = groupUploadFiles(files);
  if (grouped.size === 0) {
    throw createSkillValidationError("未解析出任何 skill");
  }

  const conflicts: ImportSkillsConflict[] = [];
  for (const [name, skillFiles] of grouped) {
    if (!skillFiles.some((file) => file.relativePath === "SKILL.md")) {
      throw createSkillValidationError(`Skill "${name}" 缺少 SKILL.md`);
    }

    const existing = await configPg.getSkill(userId, name);
    if (existing) {
      conflicts.push({ name, enabled: existing.enabled, path: existing.contentPath ?? skillContentPath(name) });
    }
  }

  if (conflicts.length > 0 && !strategy) {
    return { imported: [], skipped: [], conflicts };
  }

  const conflictNames = new Set(conflicts.map((item) => item.name));
  const skipped = strategy === "ignore" ? [...conflictNames] : [];
  const pendingEntries = [...grouped.entries()].filter(([name]) => strategy !== "ignore" || !conflictNames.has(name));

  if (pendingEntries.length === 0) {
    return { imported: [], skipped, conflicts: [] };
  }

  const backupRoot = await mkdtemp(join(tmpdir(), "rcs-skill-import-"));
  const snapshots = new Map<string, string | null>();
  const attemptedNames: string[] = [];
  const writtenNames: string[] = [];

  try {
    if (strategy === "overwrite") {
      for (const [name] of pendingEntries) {
        if (!conflictNames.has(name)) continue;
        const skillDir = join(SKILLS_DIR, name);
        if (existsSync(skillDir)) {
          const backupPath = join(backupRoot, name);
          await mkdir(backupRoot, { recursive: true });
          await cp(skillDir, backupPath, { recursive: true });
          snapshots.set(name, backupPath);
          await rm(skillDir, { recursive: true, force: true });
        } else {
          snapshots.set(name, null);
        }
        await configPg.deleteSkill(userId, name);
      }
    }

    for (const [name, skillFiles] of pendingEntries) {
      attemptedNames.push(name);
      const skillDir = join(SKILLS_DIR, name);
      await mkdir(skillDir, { recursive: true });
      for (const file of skillFiles) {
        const targetPath = join(skillDir, normalizeUploadPath(file.relativePath));
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.content, "utf-8");
      }
      writtenNames.push(name);
    }

    const imported: SkillInfo[] = [];
    for (const name of writtenNames) {
      const mdPath = skillContentPath(name);
      const raw = await readFile(mdPath, "utf-8");
      const { metadata } = parseFrontmatter(raw);
      await configPg.upsertSkill(userId, name, {
        description: metadata.description ?? "",
        contentPath: mdPath,
        enabled: true,
      });
      imported.push({ name, enabled: true, description: metadata.description ?? "", path: mdPath });
    }

    return { imported, skipped, conflicts: [] };
  } catch (error) {
    for (const name of attemptedNames) {
      const skillDir = join(SKILLS_DIR, name);
      if (existsSync(skillDir)) await rm(skillDir, { recursive: true, force: true });
      await configPg.deleteSkill(userId, name).catch(() => {});
    }
    for (const [name, backupPath] of snapshots) {
      if (backupPath && existsSync(backupPath)) {
        await cp(backupPath, join(SKILLS_DIR, name), { recursive: true });
      }
    }
    throw error;
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────
// Workspace Skill 函数（仍使用文件系统）
// ────────────────────────────────────────────

const WORKSPACE_SCAN_TIMEOUT_MS = 2000;

function getWorkspaceSkillDir(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

async function listSkillsFromDir(baseDir: string, enabled = true): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  if (!existsSync(baseDir)) return skills;
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const mdPath = join(baseDir, entry.name, "SKILL.md");
    if (!existsSync(mdPath)) continue;
    const raw = await readFile(mdPath, "utf-8");
    const { metadata } = parseFrontmatter(raw);
    skills.push({ name: entry.name, enabled, description: metadata.description ?? "", path: mdPath });
  }
  return skills;
}

export async function listWorkspaceSkills(workspacePath: string): Promise<SkillInfo[]> {
  const skillsDir = getWorkspaceSkillDir(workspacePath);
  return listSkillsFromDir(skillsDir);
}

export async function listSkillSources(userId: string): Promise<SkillSourceInfo[]> {
  const { storeListEnvironmentsByUserId } = await import("../store");
  const environments = await storeListEnvironmentsByUserId(userId);

  const globalSkills = await listSkills(userId);
  const sources: SkillSourceInfo[] = [{
    type: "global",
    name: "全局技能",
    path: SKILLS_DIR,
    status: "online",
    skills: globalSkills,
  }];

  if (environments.length === 0) return sources;

  const results = await Promise.allSettled(
    environments.map(async (env) => {
      const skills = await Promise.race([
        listWorkspaceSkills(env.workspacePath),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), WORKSPACE_SCAN_TIMEOUT_MS),
        ),
      ]);
      return { env, skills };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const env = environments[i];
    const result = results[i];
    if (result.status === "fulfilled") {
      sources.push({
        type: "workspace",
        id: env.id,
        name: env.name,
        path: env.workspacePath,
        status: env.status === "active" ? "online" : "offline",
        skills: result.value.skills,
      });
    } else {
      sources.push({
        type: "workspace",
        id: env.id,
        name: env.name,
        path: env.workspacePath,
        status: "timeout",
        skills: [],
      });
    }
  }
  return sources;
}

export async function getWorkspaceSkill(workspacePath: string, name: string): Promise<SkillDetail | null> {
  const skillsDir = getWorkspaceSkillDir(workspacePath);
  const mdPath = join(skillsDir, name, "SKILL.md");
  if (!existsSync(mdPath)) return null;
  const raw = await readFile(mdPath, "utf-8");
  const { metadata, content } = parseFrontmatter(raw);
  return {
    name,
    description: metadata.description ?? "",
    content,
    enabled: true,
    path: mdPath,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([k]) => k !== "name" && k !== "description")),
  };
}

export async function setWorkspaceSkill(
  workspacePath: string,
  name: string,
  data: { description: string; content: string; metadata?: Record<string, string> },
): Promise<SkillInfo> {
  const skillsDir = getWorkspaceSkillDir(workspacePath);
  await mkdir(skillsDir, { recursive: true });
  const skillDir = join(skillsDir, name);
  await mkdir(skillDir, { recursive: true });
  const mdContent = buildSkillMd(name, data.description, data.content, data.metadata);
  await writeFile(join(skillDir, "SKILL.md"), mdContent, "utf-8");
  return { name, enabled: true, description: data.description, path: join(skillDir, "SKILL.md") };
}

export async function deleteWorkspaceSkill(workspacePath: string, name: string): Promise<boolean> {
  const skillDir = join(getWorkspaceSkillDir(workspacePath), name);
  if (!existsSync(skillDir)) return false;
  await rm(skillDir, { recursive: true, force: true });
  return true;
}

export async function importWorkspaceSkillDirectories(
  workspacePath: string,
  files: UploadSkillFile[],
  strategy?: ImportConflictStrategy,
): Promise<ImportSkillsResult> {
  const targetDir = getWorkspaceSkillDir(workspacePath);

  if (files.length === 0) {
    throw createSkillValidationError("未提供任何上传文件");
  }

  const grouped = groupUploadFiles(files);
  if (grouped.size === 0) {
    throw createSkillValidationError("未解析出任何 skill");
  }

  const conflicts: ImportSkillsConflict[] = [];
  for (const [name, skillFiles] of grouped) {
    if (!skillFiles.some((file) => file.relativePath === "SKILL.md")) {
      throw createSkillValidationError(`Skill "${name}" 缺少 SKILL.md`);
    }
    const skillMdPath = join(targetDir, name, "SKILL.md");
    if (existsSync(skillMdPath)) {
      conflicts.push({ name, enabled: true, path: skillMdPath });
    }
  }

  if (conflicts.length > 0 && !strategy) {
    return { imported: [], skipped: [], conflicts };
  }

  const conflictNames = new Set(conflicts.map((item) => item.name));
  const skipped = strategy === "ignore" ? [...conflictNames] : [];
  const pendingEntries = [...grouped.entries()].filter(
    ([name]) => strategy !== "ignore" || !conflictNames.has(name),
  );

  if (pendingEntries.length === 0) {
    return { imported: [], skipped, conflicts: [] };
  }

  const backupRoot = await mkdtemp(join(tmpdir(), "rcs-ws-skill-import-"));
  const snapshots = new Map<string, { backupPath: string | null }>();
  const attemptedNames: string[] = [];
  const writtenNames: string[] = [];

  try {
    if (strategy === "overwrite") {
      for (const [name] of pendingEntries) {
        if (!conflictNames.has(name)) continue;
        const dir = join(targetDir, name);
        if (existsSync(dir)) {
          const backupPath = join(backupRoot, name);
          await mkdir(backupRoot, { recursive: true });
          await cp(dir, backupPath, { recursive: true });
          snapshots.set(name, { backupPath });
          await rm(dir, { recursive: true, force: true });
        } else {
          snapshots.set(name, { backupPath: null });
        }
      }
    }

    for (const [name, skillFiles] of pendingEntries) {
      attemptedNames.push(name);
      const skillDir = join(targetDir, name);
      await mkdir(skillDir, { recursive: true });
      for (const file of skillFiles) {
        const targetPath = join(skillDir, normalizeUploadPath(file.relativePath));
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.content, "utf-8");
      }
      writtenNames.push(name);
    }

    const imported: SkillInfo[] = [];
    for (const name of writtenNames) {
      const mdPath = join(targetDir, name, "SKILL.md");
      const raw = await readFile(mdPath, "utf-8");
      const { metadata } = parseFrontmatter(raw);
      imported.push({ name, enabled: true, description: metadata.description ?? "", path: mdPath });
    }

    return { imported, skipped, conflicts: [] };
  } catch (error) {
    for (const name of attemptedNames) {
      await rm(join(targetDir, name), { recursive: true, force: true });
    }
    for (const [name, snap] of snapshots) {
      if (snap.backupPath && existsSync(snap.backupPath)) {
        await cp(snap.backupPath, join(targetDir, name), { recursive: true });
      }
    }
    throw error;
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
}
