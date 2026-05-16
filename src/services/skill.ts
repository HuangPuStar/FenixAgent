/**
 * skill.ts — Skill 编排层（PG 元数据 + 文件系统内容）。
 *
 * 全局 Skill 和 Workspace Skill 的业务逻辑，
 * 文件系统操作全部委托给 skill-fs.ts。
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, error as logError } from "../logger";
import * as configPg from "./config-pg";
import {
  createSkillValidationError,
  groupUploadFiles,
  listSkillsFromDir,
  readSkillDetailFromMd,
  writeSkillMd,
  deleteSkillDir,
  resolveImportPlan,
  writeImportFiles,
  buildImportedSkillInfos,
  backupSkillDirs,
  cleanupWrittenSkills,
  restoreFromBackup,
  createBackupDir,
  cleanupBackupDir,
} from "./skill-fs";
import type {
  SkillInfo,
  SkillDetail,
  UploadSkillFile,
  ImportConflictStrategy,
  ImportSkillsConflict,
  ImportSkillsResult,
} from "./skill-fs";

// 重新导出类型，保持外部导入兼容
export type {
  SkillInfo,
  SkillDetail,
  UploadSkillFile,
  ImportConflictStrategy,
  ImportSkillsConflict,
  ImportSkillsResult,
} from "./skill-fs";

export const OLD_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");
export const SKILLS_DIR = join(homedir(), ".agents", "skills");

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
  const { cp } = await import("node:fs/promises");
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
  } catch (renameErr) {
    log("[RCS] Skills dir rename failed, falling back to copy:", renameErr);
    await cp(OLD_SKILLS_DIR, SKILLS_DIR, { recursive: true });
    await rm(OLD_SKILLS_DIR, { recursive: true, force: true });
  }

  await mkdir(OLD_SKILLS_DIR, { recursive: true });
  await writeFile(MIGRATED_MARKER, new Date().toISOString(), "utf-8");

  log("[RCS] Skills directory migrated:", OLD_SKILLS_DIR, "→", SKILLS_DIR);
}

// ────────────────────────────────────────────
// 全局 Skill 函数（PG 元数据 + 文件系统内容）
// ────────────────────────────────────────────

function skillContentPath(name: string): string {
  return join(SKILLS_DIR, name, "SKILL.md");
}

/** 过滤 metadata 中的 name 和 description 字段 */
function stripNameAndDescription(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([k]) => k !== "name" && k !== "description"),
  );
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
  const detail = await readSkillDetailFromMd(contentPath);

  return {
    name,
    description: meta.description ?? detail?.metadata.description ?? "",
    content: detail?.content ?? "",
    enabled: meta.enabled,
    path: contentPath,
    metadata: stripNameAndDescription(detail?.metadata ?? {}),
  };
}

export async function setSkill(
  userId: string,
  name: string,
  data: { description: string; content: string; metadata?: Record<string, string> },
): Promise<SkillInfo> {
  const skillDir = join(SKILLS_DIR, name);
  const contentPath = await writeSkillMd(skillDir, name, data.description, data.content, data.metadata);

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
  await deleteSkillDir(skillDir);
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

  // 校验每个 skill 必须包含 SKILL.md，同时检测冲突
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

  const { pendingEntries, skipped } = resolveImportPlan(grouped, conflicts, strategy);

  if (pendingEntries.length === 0) {
    return { imported: [], skipped, conflicts: [] };
  }

  const conflictNames = new Set(conflicts.map((item) => item.name));
  const overwriteNames = pendingEntries.filter(([name]) => conflictNames.has(name)).map(([name]) => name);

  const backupRoot = await createBackupDir("rcs-skill-import-");
  const snapshots = new Map<string, string | null>();
  const attemptedNames: string[] = [];

  try {
    // 备份并删除已有冲突目录，同时清理 PG 记录
    if (strategy === "overwrite" && overwriteNames.length > 0) {
      const backed = await backupSkillDirs(backupRoot, SKILLS_DIR, overwriteNames);
      for (const [bName, bPath] of backed) snapshots.set(bName, bPath);
      await cleanupWrittenSkills(SKILLS_DIR, overwriteNames);
      for (const name of overwriteNames) {
        await configPg.deleteSkill(userId, name);
      }
    }

    const writtenNames = await writeImportFiles(SKILLS_DIR, pendingEntries);
    attemptedNames.push(...writtenNames);

    const imported = await buildImportedSkillInfos(SKILLS_DIR, writtenNames);
    for (const info of imported) {
      await configPg.upsertSkill(userId, info.name, {
        description: info.description,
        contentPath: info.path,
        enabled: true,
      });
    }

    return { imported, skipped, conflicts: [] };
  } catch (err) {
    await cleanupWrittenSkills(SKILLS_DIR, attemptedNames);
    for (const name of attemptedNames) {
      await configPg.deleteSkill(userId, name).catch((e) => {
        logError(`[Skill] Failed to cleanup skill ${name}:`, e);
      });
    }
    await restoreFromBackup(snapshots, SKILLS_DIR);
    throw err;
  } finally {
    await cleanupBackupDir(backupRoot);
  }
}

// ────────────────────────────────────────────
// Workspace Skill 函数（仍使用文件系统）
// ────────────────────────────────────────────

const WORKSPACE_SCAN_TIMEOUT_MS = 2000;

function getWorkspaceSkillDir(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

export async function listWorkspaceSkills(workspacePath: string): Promise<SkillInfo[]> {
  const skillsDir = getWorkspaceSkillDir(workspacePath);
  return listSkillsFromDir(skillsDir);
}

export async function listSkillSources(userId: string): Promise<SkillSourceInfo[]> {
  const { environmentRepo } = await import("../repositories");
  const environments = await environmentRepo.listByUserId(userId);

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
      let timer: ReturnType<typeof setTimeout>;
      try {
        const skills = await Promise.race([
          listWorkspaceSkills(env.workspacePath),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("TIMEOUT")), WORKSPACE_SCAN_TIMEOUT_MS);
          }),
        ]);
        return { env, skills };
      } finally {
        clearTimeout(timer!);
      }
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
      const reason = result.reason;
      const isTimeout = reason instanceof Error && reason.message === "TIMEOUT";
      sources.push({
        type: "workspace",
        id: env.id,
        name: env.name,
        path: env.workspacePath,
        status: isTimeout ? "timeout" : "offline",
        skills: [],
      });
    }
  }
  return sources;
}

export async function getWorkspaceSkill(workspacePath: string, name: string): Promise<SkillDetail | null> {
  const skillsDir = getWorkspaceSkillDir(workspacePath);
  const mdPath = join(skillsDir, name, "SKILL.md");
  const detail = await readSkillDetailFromMd(mdPath);
  if (!detail) return null;

  return {
    name,
    description: detail.metadata.description ?? "",
    content: detail.content,
    enabled: true,
    path: mdPath,
    metadata: stripNameAndDescription(detail.metadata),
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
  const mdPath = await writeSkillMd(skillDir, name, data.description, data.content, data.metadata);
  return { name, enabled: true, description: data.description, path: mdPath };
}

export async function deleteWorkspaceSkill(workspacePath: string, name: string): Promise<boolean> {
  const skillDir = join(getWorkspaceSkillDir(workspacePath), name);
  if (!existsSync(skillDir)) return false;
  await deleteSkillDir(skillDir);
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

  // 校验每个 skill 必须包含 SKILL.md，同时检测冲突
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

  const { pendingEntries, skipped } = resolveImportPlan(grouped, conflicts, strategy);

  if (pendingEntries.length === 0) {
    return { imported: [], skipped, conflicts: [] };
  }

  const conflictNames = new Set(conflicts.map((item) => item.name));
  const overwriteNames = pendingEntries.filter(([name]) => conflictNames.has(name)).map(([name]) => name);

  const backupRoot = await createBackupDir("rcs-ws-skill-import-");
  const snapshots = new Map<string, string | null>();
  const attemptedNames: string[] = [];

  try {
    // 备份并删除已有冲突目录
    if (strategy === "overwrite" && overwriteNames.length > 0) {
      const backed = await backupSkillDirs(backupRoot, targetDir, overwriteNames);
      for (const [bName, bPath] of backed) snapshots.set(bName, bPath);
      await cleanupWrittenSkills(targetDir, overwriteNames);
    }

    const writtenNames = await writeImportFiles(targetDir, pendingEntries);
    attemptedNames.push(...writtenNames);

    const imported = await buildImportedSkillInfos(targetDir, writtenNames);

    return { imported, skipped, conflicts: [] };
  } catch (err) {
    await cleanupWrittenSkills(targetDir, attemptedNames);
    await restoreFromBackup(snapshots, targetDir);
    throw err;
  } finally {
    await cleanupBackupDir(backupRoot);
  }
}
