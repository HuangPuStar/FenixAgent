/**
 * skill.ts — Skill 编排层（PG 元数据 + 文件系统内容）。
 *
 * 全局技能库的业务逻辑，
 * 文件系统操作全部委托给 skill-fs.ts。
 */

import { error as logError } from "@fenix/logger";
import { config } from "../config";
import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import * as _configPg from "./config/index";
import {
  assertValidSkillName as _assertValidSkillName,
  backupSkillDirs as _backupSkillDirs,
  buildImportedSkillInfos as _buildImportedSkillInfos,
  buildSkillArchive as _buildSkillArchive,
  cleanupBackupDir as _cleanupBackupDir,
  cleanupWrittenSkills as _cleanupWrittenSkills,
  createBackupDir as _createBackupDir,
  createSkillValidationError as _createSkillValidationError,
  deleteSkillArchive as _deleteSkillArchive,
  deleteSkillDir as _deleteSkillDir,
  getSkillArchivePath as _getSkillArchivePath,
  getSkillMdPath as _getSkillMdPath,
  getSkillOrganizationDir as _getSkillOrganizationDir,
  getSkillSourceDir as _getSkillSourceDir,
  groupUploadFiles as _groupUploadFiles,
  readSkillDetailFromMd as _readSkillDetailFromMd,
  resolveImportPlan as _resolveImportPlan,
  restoreFromBackup as _restoreFromBackup,
  writeImportFiles as _writeImportFiles,
  writeSkillMd as _writeSkillMd,
} from "./skill-fs";

// ────────────────────────────────────────────
// 可替换依赖（测试时注入 mock）
// ────────────────────────────────────────────

export const _deps = {
  configPg: _configPg,
  skillFs: {
    assertValidSkillName: _assertValidSkillName,
    backupSkillDirs: _backupSkillDirs,
    getSkillOrganizationDir: _getSkillOrganizationDir,
    getSkillSourceDir: _getSkillSourceDir,
    getSkillArchivePath: _getSkillArchivePath,
    getSkillMdPath: _getSkillMdPath,
    buildSkillArchive: _buildSkillArchive,
    deleteSkillArchive: _deleteSkillArchive,
    createSkillValidationError: _createSkillValidationError,
    groupUploadFiles: _groupUploadFiles,
    readSkillDetailFromMd: _readSkillDetailFromMd,
    writeSkillMd: _writeSkillMd,
    deleteSkillDir: _deleteSkillDir,
    resolveImportPlan: _resolveImportPlan,
    writeImportFiles: _writeImportFiles,
    buildImportedSkillInfos: _buildImportedSkillInfos,
    cleanupWrittenSkills: _cleanupWrittenSkills,
    restoreFromBackup: _restoreFromBackup,
    createBackupDir: _createBackupDir,
    cleanupBackupDir: _cleanupBackupDir,
  },
};

export function _resetDeps() {
  _deps.configPg = _configPg;
  _deps.skillFs = {
    assertValidSkillName: _assertValidSkillName,
    backupSkillDirs: _backupSkillDirs,
    getSkillOrganizationDir: _getSkillOrganizationDir,
    getSkillSourceDir: _getSkillSourceDir,
    getSkillArchivePath: _getSkillArchivePath,
    getSkillMdPath: _getSkillMdPath,
    buildSkillArchive: _buildSkillArchive,
    deleteSkillArchive: _deleteSkillArchive,
    createSkillValidationError: _createSkillValidationError,
    groupUploadFiles: _groupUploadFiles,
    readSkillDetailFromMd: _readSkillDetailFromMd,
    writeSkillMd: _writeSkillMd,
    deleteSkillDir: _deleteSkillDir,
    resolveImportPlan: _resolveImportPlan,
    writeImportFiles: _writeImportFiles,
    buildImportedSkillInfos: _buildImportedSkillInfos,
    cleanupWrittenSkills: _cleanupWrittenSkills,
    restoreFromBackup: _restoreFromBackup,
    createBackupDir: _createBackupDir,
    cleanupBackupDir: _cleanupBackupDir,
  };
}

import type {
  ImportConflictStrategy,
  ImportSkillsConflict,
  ImportSkillsResult,
  SkillDetail,
  SkillInfo,
  UploadSkillFile,
} from "./skill-fs";

// 重新导出类型，保持外部导入兼容
export type {
  ImportConflictStrategy,
  ImportSkillsConflict,
  ImportSkillsResult,
  SkillDetail,
  SkillInfo,
  UploadSkillFile,
} from "./skill-fs";

export function getGlobalSkillsDir(): string {
  return config.skillDir;
}

// ────────────────────────────────────────────
// 全局 Skill 函数（PG 元数据 + 文件系统内容）
// ────────────────────────────────────────────

function resolveSkillSourceOrganizationId(
  meta: { organizationId: string; resourceAccess?: { sourceOrganizationId: string } | undefined },
  fallbackOrganizationId: string,
): string {
  return meta.resourceAccess?.sourceOrganizationId ?? meta.organizationId ?? fallbackOrganizationId;
}

function skillContentPath(organizationId: string, name: string): string {
  const safeName = _deps.skillFs.assertValidSkillName(name);
  return _deps.skillFs.getSkillMdPath(getGlobalSkillsDir(), organizationId, safeName);
}

function skillSourceDir(organizationId: string, name: string): string {
  const safeName = _deps.skillFs.assertValidSkillName(name);
  return _deps.skillFs.getSkillSourceDir(getGlobalSkillsDir(), organizationId, safeName);
}

function skillOrganizationDir(organizationId: string): string {
  return _deps.skillFs.getSkillOrganizationDir(getGlobalSkillsDir(), organizationId);
}

function skillArchivePath(organizationId: string, name: string): string {
  const safeName = _deps.skillFs.assertValidSkillName(name);
  return _deps.skillFs.getSkillArchivePath(getGlobalSkillsDir(), organizationId, safeName);
}

/** 过滤 metadata 中的 name 和 description 字段 */
function stripNameAndDescription(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).filter(([k]) => k !== "name" && k !== "description"));
}

export async function listSkills(ctx: AuthContext): Promise<SkillInfo[]> {
  const rows = await _deps.configPg.listSkills(ctx);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: true,
    description: r.description ?? "",
    path: skillContentPath(resolveSkillSourceOrganizationId(r, ctx.organizationId), r.name),
    resourceAccess: r.resourceAccess,
  }));
}

export async function getSkill(ctx: AuthContext, nameOrResourceKey: string): Promise<SkillDetail | null> {
  const isResourceKey = nameOrResourceKey.includes("/");
  const meta = isResourceKey
    ? await _deps.configPg.getSkillByResourceKey(ctx, nameOrResourceKey)
    : await _deps.configPg.getSkill(ctx, _deps.skillFs.assertValidSkillName(nameOrResourceKey));
  if (!meta) return null;

  const contentPath = skillContentPath(resolveSkillSourceOrganizationId(meta, ctx.organizationId), meta.name);
  const detail = await _deps.skillFs.readSkillDetailFromMd(contentPath);

  return {
    name: meta.name,
    description: meta.description ?? detail?.metadata.description ?? "",
    content: detail?.content ?? "",
    enabled: true,
    path: contentPath,
    metadata: stripNameAndDescription(detail?.metadata ?? {}),
    resourceAccess: meta.resourceAccess,
  };
}

export async function setSkill(
  ctx: AuthContext,
  name: string,
  data: { description: string; content: string; metadata?: Record<string, string>; publicReadable?: boolean },
): Promise<SkillInfo> {
  const { publicReadable, ...skillData } = data;
  const safeName = _deps.skillFs.assertValidSkillName(name);
  const skillDir = skillSourceDir(ctx.organizationId, safeName);
  const archivePath = skillArchivePath(ctx.organizationId, safeName);
  const backupRoot = await _deps.skillFs.createBackupDir("rcs-skill-set-");
  const targetDir = skillOrganizationDir(ctx.organizationId);
  const snapshots = await _deps.skillFs.backupSkillDirs(backupRoot, targetDir, [safeName]);

  try {
    const contentPath = await _deps.skillFs.writeSkillMd(
      skillDir,
      safeName,
      skillData.description,
      skillData.content,
      skillData.metadata,
    );
    await _deps.skillFs.buildSkillArchive(skillDir, archivePath);
    await _deps.configPg.upsertSkill(
      ctx,
      safeName,
      {
        description: skillData.description,
        metadata: skillData.metadata,
      },
      { publicReadable, auditAction: "set" },
    );
    const updatedMeta = await _deps.configPg.getSkill(ctx, safeName).catch(() => null);

    return {
      id: updatedMeta?.id,
      name: safeName,
      enabled: true,
      description: skillData.description,
      path: contentPath,
      resourceAccess: updatedMeta?.resourceAccess,
    };
  } catch (err) {
    await _deps.skillFs.cleanupWrittenSkills(targetDir, [safeName]).catch((e) => {
      logError("[Skill] Failed to cleanup skill directory after setSkill failure:", e);
    });
    await _deps.skillFs.restoreFromBackup(snapshots, targetDir).catch((e) => {
      logError("[Skill] Failed to restore skill backup after setSkill failure:", e);
    });
    const snapshot = snapshots.get(safeName);
    if (snapshot) {
      await _deps.skillFs.buildSkillArchive(skillDir, archivePath).catch((e) => {
        logError("[Skill] Failed to rebuild restored skill archive:", e);
      });
    } else {
      await _deps.skillFs.deleteSkillArchive(getGlobalSkillsDir(), ctx.organizationId, safeName).catch((e) => {
        logError("[Skill] Failed to cleanup skill archive after setSkill failure:", e);
      });
    }
    throw err;
  } finally {
    await _deps.skillFs.cleanupBackupDir(backupRoot).catch((e) => {
      logError("[Skill] Failed to cleanup setSkill backup dir:", e);
    });
  }
}

export async function deleteSkill(ctx: AuthContext, name: string): Promise<boolean> {
  const safeName = _deps.skillFs.assertValidSkillName(name);
  const meta = await _deps.configPg.getSkill(ctx, safeName);
  if (!meta) return false;
  if (meta.resourceAccess?.writable === false) {
    throw new AppError("External skill is read-only", "FORBIDDEN", 403);
  }

  const deleted = await _deps.configPg.deleteSkill(ctx, safeName);
  if (!deleted) return false;
  const sourceOrganizationId = resolveSkillSourceOrganizationId(meta, ctx.organizationId);
  const skillDir = skillSourceDir(sourceOrganizationId, safeName);
  await _deps.skillFs.deleteSkillDir(skillDir).catch((e) => {
    logError(`[Skill] Failed to cleanup skill directory ${skillDir}:`, e);
  });
  await _deps.skillFs.deleteSkillArchive(getGlobalSkillsDir(), sourceOrganizationId, safeName).catch((e) => {
    logError(`[Skill] Failed to cleanup skill archive ${safeName}:`, e);
  });
  return true;
}

/** 校验上传文件并检测冲突 */
function validateImportFiles(files: UploadSkillFile[]): Map<string, UploadSkillFile[]> {
  if (files.length === 0) {
    throw _deps.skillFs.createSkillValidationError("未提供任何上传文件");
  }
  const grouped = _deps.skillFs.groupUploadFiles(files);
  if (grouped.size === 0) {
    throw _deps.skillFs.createSkillValidationError("未解析出任何 skill");
  }
  for (const [name, skillFiles] of grouped) {
    if (!skillFiles.some((file) => file.relativePath === "SKILL.md")) {
      throw _deps.skillFs.createSkillValidationError(`Skill "${name}" 缺少 SKILL.md`);
    }
  }
  return grouped;
}

/** 通用导入核心：备份→写入→回滚 */
async function executeImportCore(
  targetDir: string,
  pendingEntries: [string, UploadSkillFile[]][],
  overwriteNames: string[],
  backupPrefix: string,
  onConflictCleanup?: (names: string[]) => Promise<void>,
  onSkillWritten?: (info: { name: string; description: string; path: string }) => Promise<void>,
  onRollbackCleanup?: (names: string[]) => Promise<void>,
  onRestoreComplete?: (names: string[]) => Promise<void>,
): Promise<ImportSkillsResult> {
  const backupRoot = await _deps.skillFs.createBackupDir(backupPrefix);
  const snapshots = new Map<string, string | null>();
  const attemptedNames: string[] = [];

  try {
    if (overwriteNames.length > 0) {
      const backed = await _deps.skillFs.backupSkillDirs(backupRoot, targetDir, overwriteNames);
      for (const [bName, bPath] of backed) snapshots.set(bName, bPath);
      await _deps.skillFs.cleanupWrittenSkills(targetDir, overwriteNames);
      if (onConflictCleanup) await onConflictCleanup(overwriteNames);
    }

    const writtenNames = await _deps.skillFs.writeImportFiles(targetDir, pendingEntries);
    attemptedNames.push(...writtenNames);

    const imported = await _deps.skillFs.buildImportedSkillInfos(targetDir, writtenNames);

    if (onSkillWritten) {
      await Promise.all(imported.map((info) => onSkillWritten(info)));
    }

    return { imported, skipped: [], conflicts: [] };
  } catch (err) {
    try {
      await _deps.skillFs.cleanupWrittenSkills(targetDir, attemptedNames);
    } catch (e) {
      logError("[Skill] Failed to cleanup written skills:", e);
    }
    if (onRollbackCleanup) {
      await onRollbackCleanup(attemptedNames).catch((e) => {
        logError("[Skill] Failed to rollback PG records:", e);
      });
    }
    try {
      await _deps.skillFs.restoreFromBackup(snapshots, targetDir);
      if (onRestoreComplete && snapshots.size > 0) {
        await onRestoreComplete([...snapshots.keys()]);
      }
    } catch (e) {
      logError("[Skill] Failed to restore from backup:", e);
    }
    throw err;
  } finally {
    try {
      await _deps.skillFs.cleanupBackupDir(backupRoot);
    } catch (e) {
      logError("[Skill] Failed to cleanup backup dir:", e);
    }
  }
}

export async function importSkillDirectories(
  ctx: AuthContext,
  files: UploadSkillFile[],
  strategy?: ImportConflictStrategy,
): Promise<ImportSkillsResult> {
  const grouped = validateImportFiles(files);
  const root = getGlobalSkillsDir();
  const targetDir = skillOrganizationDir(ctx.organizationId);

  // 并行检测冲突（N+1 → 单轮并行查询）
  const entries = Array.from(grouped.entries());
  const existingResults = await Promise.all(
    entries.map(async ([name]) => {
      const existing = await _deps.configPg.getSkill(ctx, name);
      return existing
        ? {
            name,
            existing,
            enabled: true,
            path: skillContentPath(resolveSkillSourceOrganizationId(existing, ctx.organizationId), name),
          }
        : null;
    }),
  );
  const existingConflicts = existingResults.filter(
    (r): r is NonNullable<(typeof existingResults)[number]> => r !== null,
  );
  const conflicts: ImportSkillsConflict[] = existingConflicts.map(({ name, enabled, path }) => ({
    name,
    enabled,
    path,
  }));

  if (conflicts.length > 0 && !strategy) {
    return { imported: [], skipped: [], conflicts };
  }

  const { pendingEntries, skipped } = _deps.skillFs.resolveImportPlan(grouped, conflicts, strategy);

  if (pendingEntries.length === 0) {
    return { imported: [], skipped, conflicts: [] };
  }

  const conflictNames = new Set(conflicts.map((item) => item.name));
  const overwriteNames = pendingEntries.filter(([name]) => conflictNames.has(name)).map(([name]) => name);
  const overwriteNameSet = new Set(overwriteNames);
  const overwriteExistingByName = new Map(
    existingConflicts
      .filter(({ name }) => overwriteNameSet.has(name))
      .map(({ name, existing }) => [name, existing] as const),
  );

  const result = await executeImportCore(
    targetDir,
    pendingEntries,
    overwriteNames,
    "rcs-skill-import-",
    undefined,
    // onSkillWritten: 并行写入 PG 元数据
    async (info) => {
      await _deps.skillFs.buildSkillArchive(
        _deps.skillFs.getSkillSourceDir(root, ctx.organizationId, info.name),
        _deps.skillFs.getSkillArchivePath(root, ctx.organizationId, info.name),
      );
      await _deps.configPg.upsertSkill(
        ctx,
        info.name,
        {
          description: info.description,
        },
        { auditAction: overwriteNames.includes(info.name) ? "upload_overwrite" : "upload_create" },
      );
    },
    // onRollbackCleanup: 回滚时清理已尝试写入的 PG 记录
    async (names) => {
      const deleteNames = names.filter((name) => !overwriteNameSet.has(name));
      const restoreNames = names.filter((name) => overwriteNameSet.has(name));

      await Promise.all([
        ...deleteNames.map((name) => _deps.configPg.deleteSkill(ctx, name)),
        ...restoreNames.map(async (name) => {
          const existing = overwriteExistingByName.get(name);
          if (!existing) return;
          await _deps.configPg.upsertSkill(
            ctx,
            name,
            {
              description: existing.description ?? undefined,
              metadata:
                existing.metadata && typeof existing.metadata === "object"
                  ? (existing.metadata as Record<string, string>)
                  : undefined,
            },
            { auditAction: "upload_overwrite" },
          );
        }),
        ...names.map((name) => _deps.skillFs.deleteSkillArchive(root, ctx.organizationId, name)),
      ]);
    },
    async (names) => {
      await Promise.all(
        names.map((name) =>
          _deps.skillFs.buildSkillArchive(
            _deps.skillFs.getSkillSourceDir(root, ctx.organizationId, name),
            _deps.skillFs.getSkillArchivePath(root, ctx.organizationId, name),
          ),
        ),
      );
    },
  );

  return { ...result, skipped };
}
