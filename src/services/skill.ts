/**
 * skill.ts — Skill 编排层（PG 元数据 + 文件系统内容）。
 *
 * 全局 Skill 和 Workspace Skill 的业务逻辑，
 * 文件系统操作全部委托给 skill-fs.ts。
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log, error as logError } from "../logger";
import { environmentRepo } from "../repositories";
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
    const { cp, rm, writeFile: writeFileFn } = await import("node:fs/promises");
    await cp(OLD_SKILLS_DIR, SKILLS_DIR, { recursive: true });
    await rm(OLD_SKILLS_DIR, { recursive: true, force: true });
    await writeFileFn(MIGRATED_MARKER, new Date().toISOString(), "utf-8");
    log("[RCS] Skills directory migrated:", OLD_SKILLS_DIR, "→", SKILLS_DIR);
    return;
  }

  const { writeFile: writeFileFn } = await import("node:fs/promises");
  await mkdir(OLD_SKILLS_DIR, { recursive: true });
  await writeFileFn(MIGRATED_MARKER, new Date().toISOString(), "utf-8");

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

  try {
    await configPg.upsertSkill(userId, name, {
      description: data.description,
      contentPath,
      metadata: data.metadata,
      enabled: true,
    });
  } catch (err) {
    await deleteSkillDir(skillDir).catch((e) => {
      logError(`[Skill] Failed to cleanup skill directory after PG upsert failure:`, e);
    });
    throw err;
  }

  return { name, enabled: true, description: data.description, path: contentPath };
}

export async function deleteSkill(userId: string, name: string): Promise<boolean> {
  const deleted = await configPg.deleteSkill(userId, name);
  if (!deleted) return false;
  const skillDir = join(SKILLS_DIR, name);
  await deleteSkillDir(skillDir).catch((e) => {
    logError(`[Skill] Failed to cleanup skill directory ${skillDir}:`, e);
  });
  return true;
}

export async function enableSkill(userId: string, name: string): Promise<boolean> {
  return configPg.enableSkill(userId, name);
}

export async function disableSkill(userId: string, name: string): Promise<boolean> {
  return configPg.disableSkill(userId, name);
}

/** 校验上传文件并检测冲突（全局和 workspace 共享） */
function validateImportFiles(files: UploadSkillFile[]): Map<string, UploadSkillFile[]> {
  if (files.length === 0) {
    throw createSkillValidationError("未提供任何上传文件");
  }
  const grouped = groupUploadFiles(files);
  if (grouped.size === 0) {
    throw createSkillValidationError("未解析出任何 skill");
  }
  for (const [name, skillFiles] of grouped) {
    if (!skillFiles.some((file) => file.relativePath === "SKILL.md")) {
      throw createSkillValidationError(`Skill "${name}" 缺少 SKILL.md`);
    }
  }
  return grouped;
}

/** 通用导入核心：备份→写入→回滚（全局和 workspace 共享） */
async function executeImportCore(
  targetDir: string,
  pendingEntries: [string, UploadSkillFile[]][],
  overwriteNames: string[],
  backupPrefix: string,
  onConflictCleanup?: (names: string[]) => Promise<void>,
  onSkillWritten?: (info: { name: string; description: string; path: string }) => Promise<void>,
  onRollbackCleanup?: (names: string[]) => Promise<void>,
): Promise<ImportSkillsResult> {
  const backupRoot = await createBackupDir(backupPrefix);
  const snapshots = new Map<string, string | null>();
  const attemptedNames: string[] = [];

  try {
    if (overwriteNames.length > 0) {
      const backed = await backupSkillDirs(backupRoot, targetDir, overwriteNames);
      for (const [bName, bPath] of backed) snapshots.set(bName, bPath);
      await cleanupWrittenSkills(targetDir, overwriteNames);
      if (onConflictCleanup) await onConflictCleanup(overwriteNames);
    }

    const writtenNames = await writeImportFiles(targetDir, pendingEntries);
    attemptedNames.push(...writtenNames);

    const imported = await buildImportedSkillInfos(targetDir, writtenNames);

    if (onSkillWritten) {
      await Promise.all(imported.map((info) => onSkillWritten(info)));
    }

    return { imported, skipped: [], conflicts: [] };
  } catch (err) {
    try { await cleanupWrittenSkills(targetDir, attemptedNames); } catch (e) { logError("[Skill] Failed to cleanup written skills:", e); }
    if (onRollbackCleanup) {
      await onRollbackCleanup(attemptedNames).catch((e) => {
        logError("[Skill] Failed to rollback PG records:", e);
      });
    }
    try { await restoreFromBackup(snapshots, targetDir); } catch (e) { logError("[Skill] Failed to restore from backup:", e); }
    throw err;
  } finally {
    try { await cleanupBackupDir(backupRoot); } catch (e) { logError("[Skill] Failed to cleanup backup dir:", e); }
  }
}

export async function importSkillDirectories(
  userId: string,
  files: UploadSkillFile[],
  strategy?: ImportConflictStrategy,
): Promise<ImportSkillsResult> {
  const grouped = validateImportFiles(files);

  // 并行检测冲突（N+1 → 单轮并行查询）
  const entries = Array.from(grouped.entries());
  const existingResults = await Promise.all(
    entries.map(async ([name]) => {
      const existing = await configPg.getSkill(userId, name);
      return existing
        ? { name, enabled: existing.enabled, path: existing.contentPath ?? skillContentPath(name) }
        : null;
    }),
  );
  const conflicts: ImportSkillsConflict[] = existingResults.filter((r): r is ImportSkillsConflict => r !== null);

  if (conflicts.length > 0 && !strategy) {
    return { imported: [], skipped: [], conflicts };
  }

  const { pendingEntries, skipped } = resolveImportPlan(grouped, conflicts, strategy);

  if (pendingEntries.length === 0) {
    return { imported: [], skipped, conflicts: [] };
  }

  const conflictNames = new Set(conflicts.map((item) => item.name));
  const overwriteNames = pendingEntries.filter(([name]) => conflictNames.has(name)).map(([name]) => name);

  const result = await executeImportCore(
    SKILLS_DIR,
    pendingEntries,
    strategy === "overwrite" ? overwriteNames : [],
    "rcs-skill-import-",
    // onConflictCleanup: overwrite 时清理 PG 冲突记录（pre-write）
    strategy === "overwrite" ? async (names) => {
      await Promise.all(names.map((name) => configPg.deleteSkill(userId, name)));
    } : undefined,
    // onSkillWritten: 并行写入 PG 元数据
    async (info) => {
      await configPg.upsertSkill(userId, info.name, {
        description: info.description,
        contentPath: info.path,
        enabled: true,
      });
    },
    // onRollbackCleanup: 回滚时清理已尝试写入的 PG 记录
    async (names) => {
      await Promise.all(names.map((name) => configPg.deleteSkill(userId, name)));
    },
  );

  return { ...result, skipped };
}
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
  // 两个查询无依赖关系，并行执行
  const [environments, globalSkills] = await Promise.all([
    environmentRepo.listByUserId(userId),
    listSkills(userId),
  ]);
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const skills = await Promise.race([
          listWorkspaceSkills(env.workspacePath),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("TIMEOUT")), WORKSPACE_SCAN_TIMEOUT_MS);
          }),
        ]);
        return { env, skills };
      } finally {
        if (timer) clearTimeout(timer);
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
  const grouped = validateImportFiles(files);

  // workspace skill 冲突检测基于文件系统存在性
  const conflicts: ImportSkillsConflict[] = [];
  for (const [name] of grouped) {
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

  const result = await executeImportCore(
    targetDir,
    pendingEntries,
    strategy === "overwrite" ? overwriteNames : [],
    "rcs-ws-skill-import-",
  );

  return { ...result, skipped };
}
