import { readdir, readFile, writeFile, mkdir, rename, rm, cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

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

interface SkillDirSnapshot {
  name: string;
  enabledBackupPath: string | null;
  disabledBackupPath: string | null;
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

async function snapshotSkillDir(name: string, backupRoot: string): Promise<SkillDirSnapshot> {
  const enabledDir = join(SKILLS_DIR, name);
  const disabledDir = join(DISABLED_DIR, name);
  const enabledBackupPath = existsSync(enabledDir) ? join(backupRoot, "enabled", name) : null;
  const disabledBackupPath = existsSync(disabledDir) ? join(backupRoot, "disabled", name) : null;

  if (enabledBackupPath) {
    await mkdir(dirname(enabledBackupPath), { recursive: true });
    await cp(enabledDir, enabledBackupPath, { recursive: true });
  }
  if (disabledBackupPath) {
    await mkdir(dirname(disabledBackupPath), { recursive: true });
    await cp(disabledDir, disabledBackupPath, { recursive: true });
  }

  return { name, enabledBackupPath, disabledBackupPath };
}

async function restoreSkillDir(snapshot: SkillDirSnapshot): Promise<void> {
  const enabledDir = join(SKILLS_DIR, snapshot.name);
  const disabledDir = join(DISABLED_DIR, snapshot.name);

  await rm(enabledDir, { recursive: true, force: true });
  await rm(disabledDir, { recursive: true, force: true });

  if (snapshot.enabledBackupPath && existsSync(snapshot.enabledBackupPath)) {
    await mkdir(dirname(enabledDir), { recursive: true });
    await cp(snapshot.enabledBackupPath, enabledDir, { recursive: true });
  }
  if (snapshot.disabledBackupPath && existsSync(snapshot.disabledBackupPath)) {
    await ensureDisabledDir();
    await cp(snapshot.disabledBackupPath, disabledDir, { recursive: true });
  }
}

async function writeImportedSkill(name: string, files: UploadSkillFile[]): Promise<void> {
  const skillDir = join(SKILLS_DIR, name);
  await mkdir(skillDir, { recursive: true });

  for (const file of files) {
    const targetPath = join(skillDir, normalizeUploadPath(file.relativePath));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf-8");
  }
}

async function readImportedSkillInfo(name: string): Promise<SkillInfo> {
  const mdPath = join(SKILLS_DIR, name, "SKILL.md");
  const raw = await readFile(mdPath, "utf-8");
  const { metadata } = parseFrontmatter(raw);
  return { name, enabled: true, description: metadata.description ?? "", path: mdPath };
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

export async function listSkills(): Promise<SkillInfo[]> {
  return [
    ...await listSkillsFromDir(SKILLS_DIR, true),
    ...await listSkillsFromDir(DISABLED_DIR, false),
  ];
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

export async function importSkillDirectories(
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

    const enabledPath = join(SKILLS_DIR, name, "SKILL.md");
    const disabledPath = join(DISABLED_DIR, name, "SKILL.md");
    if (existsSync(enabledPath)) {
      conflicts.push({ name, enabled: true, path: enabledPath });
    } else if (existsSync(disabledPath)) {
      conflicts.push({ name, enabled: false, path: disabledPath });
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
  const snapshots = new Map<string, SkillDirSnapshot>();
  const attemptedNames: string[] = [];
  const writtenNames: string[] = [];

  try {
    if (strategy === "overwrite") {
      for (const [name] of pendingEntries) {
        if (!conflictNames.has(name)) continue;
        const snapshot = await snapshotSkillDir(name, backupRoot);
        snapshots.set(name, snapshot);
        await deleteSkillInternal(name);
      }
    }

    for (const [name, skillFiles] of pendingEntries) {
      attemptedNames.push(name);
      await writeImportedSkill(name, skillFiles);
      writtenNames.push(name);
    }

    const imported = [];
    for (const name of writtenNames) {
      imported.push(await readImportedSkillInfo(name));
    }

    return { imported, skipped, conflicts: [] };
  } catch (error) {
    for (const name of attemptedNames) {
      await deleteSkillInternal(name);
    }
    for (const snapshot of snapshots.values()) {
      await restoreSkillDir(snapshot);
    }
    throw error;
  } finally {
    await rm(backupRoot, { recursive: true, force: true });
  }
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

// --- Workspace Skill Functions ---

const WORKSPACE_SCAN_TIMEOUT_MS = 2000;

function getWorkspaceSkillDir(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

export async function listWorkspaceSkills(workspacePath: string): Promise<SkillInfo[]> {
  const skillsDir = getWorkspaceSkillDir(workspacePath);
  return listSkillsFromDir(skillsDir);
}

export async function listSkillSources(userId: string): Promise<SkillSourceInfo[]> {
  const { storeListEnvironmentsByUserId } = await import("../store");
  const environments = storeListEnvironmentsByUserId(userId);

  const globalSkills = await listSkills();
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
