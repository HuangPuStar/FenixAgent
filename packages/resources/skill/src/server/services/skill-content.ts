/**
 * Skill 文档内容层：SKILL.md 与归档文件（`skill-fs.ts`）的编排。
 *
 * 与 `skill-service.ts` 的边界是「文档内容」与「资源行」：本模块只碰文件系统，不知道授权、不知道
 * 资源归属，也不写数据库；调用方（Facade 或系统路径）负责把这些写入与资源行变更按正确顺序编排，
 * 并在失败时调用 {@link rollbackSkillWrite}。
 *
 * 之所以把「备份 → 写入 → 归档」这一串留在这里而不是交给 Facade：它是文件系统这个介质自己的一致性
 * 规则（写入中途失败必须恢复快照并回滚归档），换任何调用方都一样，属于资源包内部知识。
 */

import { error as logError } from "@fenix/logger";
import { ValidationError } from "@fenix/platform-sdk";
import { getSkillConfig } from "../config";
import type {
  ImportConflictStrategy,
  ImportSkillsConflict,
  ImportSkillsResult,
  SkillDocumentContent,
  UploadSkillFile,
} from "./skill-fs";
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
  parseFrontmatter as _parseFrontmatter,
  readSkillDetailFromMd as _readSkillDetailFromMd,
  readSkillDocumentFromMd as _readSkillDocumentFromMd,
  resolveImportPlan as _resolveImportPlan,
  restoreFromBackup as _restoreFromBackup,
  writeImportFiles as _writeImportFiles,
  writeSkillMd as _writeSkillMd,
} from "./skill-fs";

export type {
  ImportConflictStrategy,
  ImportSkillsConflict,
  ImportSkillsResult,
  SkillDocumentContent,
  SkillInfo,
  UploadSkillFile,
} from "./skill-fs";

// ────────────────────────────────────────────
// 可替换依赖（测试时注入文件系统替身，避免触碰真实目录）
// ────────────────────────────────────────────

const skillFs = {
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
  readSkillDocumentFromMd: _readSkillDocumentFromMd,
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

const defaultSkillFs = { ...skillFs };

/** 文件系统依赖接缝；替换项在测试结束时必须经 {@link resetSkillContentDeps} 还原。 */
export const _deps = { skillFs };

/** 还原文件系统依赖，防止跨测试文件共享替身。 */
export function resetSkillContentDeps(): void {
  Object.assign(_deps.skillFs, defaultSkillFs);
}

/**
 * 技能根目录（宿主 `SKILL_DIR` 解析结果）。
 *
 * 每次调用都从模块配置读取，不在模块顶层缓存：宿主可能尚未完成
 * `initializeApplicationInfrastructure()` 就导入本模块，固化值会把导入顺序变成隐式启动依赖。
 */
export function getGlobalSkillsDir(): string {
  return getSkillConfig().skillDir;
}

// ────────────────────────────────────────────
// 路径解析（组织级目录布局）
// ────────────────────────────────────────────

/**
 * 校验并规范化技能名称（去空白、拒绝空名称与路径穿越）。
 *
 * 写路径必须在**写资源行之前**调用一次：名称不合法属于请求错误，不应该在库里留下行之后才发现。
 *
 * 抛出宿主的 {@link ValidationError} 而不是内容层的裸 `code` 错误：调用方（Facade）的契约是"只抛
 * AppError 子类"，协议层因此不必各自识别错误形状。
 */
export function validateSkillName(name: string): string {
  try {
    return _deps.skillFs.assertValidSkillName(name);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Skill 名称不合法");
  }
}

/** SKILL.md 的绝对路径；名称先做安全校验，避免路径穿越。 */
export function skillContentPath(organizationId: string, name: string): string {
  const safeName = _deps.skillFs.assertValidSkillName(name);
  return _deps.skillFs.getSkillMdPath(getGlobalSkillsDir(), organizationId, safeName);
}

/** 技能源目录（SKILL.md 所在目录）的绝对路径。 */
export function skillSourceDir(organizationId: string, name: string): string {
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

// ────────────────────────────────────────────
// 文档读写
// ────────────────────────────────────────────

/** 过滤 metadata 中的 name 和 description 字段（它们由资源行的列承载，不进入 metadata）。 */
export function stripNameAndDescription<T>(metadata: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "name" && key !== "description"));
}

/**
 * 资源行侧可承载的元数据投影。
 *
 * frontmatter 的 YAML 原始类型比资源行的 string map 宽（写回文件时必须保留原始类型，否则嵌套结构会被
 * 有损地 yaml dump 成字符串），因此两份介质在这一点上必然不对称：非字符串值随文件走，不进资源行。
 */
function toRowMetadata(metadata: Record<string, unknown>): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 规范化写入参数，兼容把完整 SKILL.md 误传到 content 的 API 调用方。
 *
 * 正式契约仍是接收 Markdown 正文；这里在持久化边界剥离一个或多个已有 frontmatter，
 * 避免 API 客户端再次包裹出重复头部。
 */
export function normalizeSkillWriteData(data: {
  description: string;
  content: string;
  metadata?: Record<string, string>;
}): { description: string; content: string; metadata?: Record<string, string> } {
  let content = data.content;
  let embeddedMetadata: Record<string, string> = {};

  while (true) {
    const parsed = _parseFrontmatter(content);
    const isCompleteSkill = parsed.metadata.name !== undefined || parsed.metadata.description !== undefined;
    if (!isCompleteSkill || parsed.content === content) break;
    embeddedMetadata = { ...embeddedMetadata, ...stripNameAndDescription(parsed.metadata) };
    content = parsed.content;
  }

  const metadata = { ...embeddedMetadata, ...(data.metadata ?? {}) };
  return {
    description: data.description,
    content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/** 读取 SKILL.md；文件不存在或不可读返回 null（调用方决定"内容缺失"如何呈现）。 */
export async function readSkillDetail(organizationId: string, name: string): Promise<SkillDocumentContent | null> {
  return (await _deps.skillFs.readSkillDetailFromMd(skillContentPath(organizationId, name))) ?? null;
}

/** 写入结果：写盘路径与最终落盘的元数据，供调用方回写资源行。 */
export interface WrittenSkillDocument {
  readonly contentPath: string;
  readonly description: string;
  /**
   * 最终写进 SKILL.md frontmatter 的元数据中、资源行可承载的部分（既有文档的键与本次入参合并后
   * 的字符串值；非字符串值只留在文件里，见 {@link toRowMetadata}）。
   *
   * 资源行列必须写这一份而不是原始入参：文档头里保留下来的键（如 builtin 标记）如果没进资源行，
   * 两份介质就会各说一套，孤儿清理之类的行侧判断会读到错的标记。
   */
  readonly metadata?: Record<string, string>;
}

/**
 * 写入 SKILL.md 与归档，并在同一份快照的保护下执行资源行写入。
 *
 * 快照 + `persist` 构成一次补偿写入：`persist` 抛错（唯一索引冲突、资源行被并发删除、数据库故障）
 * 时先恢复快照、再同步归档，然后把原始错误抛给调用方——调用方因此不会看到"文件已改但资源行未改"
 * 或"资源行已改但文件是旧的"的中间态。
 *
 * 之所以由本模块持有 `persist` 而不是让调用方在外部编排：快照、写入、恢复这三步必须成对出现，
 * 分散到调用方就会有人漏掉恢复路径；资源行写什么则完全是调用方的知识，因此以回调传入。
 */
export async function writeSkillDocument(input: {
  organizationId: string;
  name: string;
  description: string;
  content: string;
  metadata?: Record<string, string>;
  /**
   * 依赖这次文件内容的资源行写入；抛错即回滚文件内容。
   *
   * 创建路径不传：它在写文件之前就已经建好资源行，内容写入失败时由 Facade 删除该行补偿。
   */
  persist?: (written: WrittenSkillDocument) => Promise<void>;
}): Promise<WrittenSkillDocument> {
  const safeName = _deps.skillFs.assertValidSkillName(input.name);
  const skillDir = skillSourceDir(input.organizationId, safeName);
  const existingDocument = await _deps.skillFs.readSkillDocumentFromMd(
    skillContentPath(input.organizationId, safeName),
  );
  const preservedMetadata = stripNameAndDescription(existingDocument?.metadata ?? {});
  const writeMetadata = { ...preservedMetadata, ...(input.metadata ?? {}) };
  const archivePath = skillArchivePath(input.organizationId, safeName);
  const backupRoot = await _deps.skillFs.createBackupDir("rcs-skill-set-");
  const targetDir = skillOrganizationDir(input.organizationId);
  const snapshots = await _deps.skillFs.backupSkillDirs(backupRoot, targetDir, [safeName]);

  try {
    const contentPath = await _deps.skillFs.writeSkillMd(
      skillDir,
      safeName,
      input.description,
      input.content,
      Object.keys(writeMetadata).length > 0 ? writeMetadata : undefined,
    );
    await _deps.skillFs.buildSkillArchive(skillDir, archivePath);
    const rowMetadata = toRowMetadata(writeMetadata);
    const written: WrittenSkillDocument = {
      contentPath,
      description: input.description,
      ...(rowMetadata === undefined ? {} : { metadata: rowMetadata }),
    };
    if (input.persist) await input.persist(written);
    return written;
  } catch (err) {
    // 判定依据是"这个技能确实留下了备份"，而不是"快照表非空"：`backupSkillDirs` 对不存在的目录也会写入
    // `null` 占位，按表大小判断会把新建路径误当成覆盖路径，于是去重建一个刚被删掉的目录，并把本次写入
    // 产生的归档留在磁盘上。
    const snapshotPath = snapshots.get(safeName) ?? null;
    await rollbackSkillWrite({
      organizationId: input.organizationId,
      name: safeName,
      targetDir,
      archivePath,
      skillDir,
      hasSnapshot: snapshotPath !== null,
      snapshots,
    });
    throw err;
  } finally {
    await _deps.skillFs.cleanupBackupDir(backupRoot).catch((error) => {
      logError("[Skill] Failed to cleanup setSkill backup dir:", error);
    });
  }
}

/** 写入失败后的文件系统回滚：删除半成品、恢复快照、同步归档。 */
async function rollbackSkillWrite(input: {
  organizationId: string;
  name: string;
  targetDir: string;
  archivePath: string;
  skillDir: string;
  hasSnapshot: boolean;
  snapshots: Map<string, string | null>;
}): Promise<void> {
  await _deps.skillFs.cleanupWrittenSkills(input.targetDir, [input.name]).catch((error) => {
    logError("[Skill] Failed to cleanup skill directory after write failure:", error);
  });
  await _deps.skillFs.restoreFromBackup(input.snapshots, input.targetDir).catch((error) => {
    logError("[Skill] Failed to restore skill backup after write failure:", error);
  });
  if (input.hasSnapshot) {
    await _deps.skillFs.buildSkillArchive(input.skillDir, input.archivePath).catch((error) => {
      logError("[Skill] Failed to rebuild restored skill archive:", error);
    });
    return;
  }
  await _deps.skillFs.deleteSkillArchive(getGlobalSkillsDir(), input.organizationId, input.name).catch((error) => {
    logError("[Skill] Failed to cleanup skill archive after write failure:", error);
  });
}

/**
 * 删除技能的文件内容（源目录与归档）。
 *
 * 资源行由调用方删除：先删行再删内容时，内容清理失败只留下不可达文件，不会产生"行已删但用户仍
 * 能看到内容"或"内容已删但行还在"的可见不一致，因此这里的失败只记录日志、不上抛。
 */
export async function deleteSkillDocument(input: { organizationId: string; name: string }): Promise<void> {
  const safeName = _deps.skillFs.assertValidSkillName(input.name);
  const skillDir = skillSourceDir(input.organizationId, safeName);
  await _deps.skillFs.deleteSkillDir(skillDir).catch((error) => {
    logError(`[Skill] Failed to cleanup skill directory ${skillDir}:`, error);
  });
  await _deps.skillFs.deleteSkillArchive(getGlobalSkillsDir(), input.organizationId, safeName).catch((error) => {
    logError(`[Skill] Failed to cleanup skill archive ${safeName}:`, error);
  });
}

// ────────────────────────────────────────────
// 批量导入
// ────────────────────────────────────────────

/**
 * 校验上传文件并按技能分组。
 *
 * 单独导出是为了让调用方在写入前用它做冲突检测（冲突检测需要授权信息，属于调用方的知识）；
 * {@link importSkillDirectories} 内部再调用一次，保证"没经过校验的文件不会被写入"。
 */
export function groupUploadFilesForImport(files: UploadSkillFile[]): Map<string, UploadSkillFile[]> {
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
      for (const [name, path] of backed) snapshots.set(name, path);
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
    } catch (error) {
      logError("[Skill] Failed to cleanup written skills:", error);
    }
    if (onRollbackCleanup) {
      await onRollbackCleanup(attemptedNames).catch((error) => {
        logError("[Skill] Failed to rollback PG records:", error);
      });
    }
    try {
      await _deps.skillFs.restoreFromBackup(snapshots, targetDir);
      if (onRestoreComplete && snapshots.size > 0) {
        await onRestoreComplete([...snapshots.keys()]);
      }
    } catch (error) {
      logError("[Skill] Failed to restore from backup:", error);
    }
    throw err;
  } finally {
    try {
      await _deps.skillFs.cleanupBackupDir(backupRoot);
    } catch (error) {
      logError("[Skill] Failed to cleanup backup dir:", error);
    }
  }
}

/**
 * 导入技能目录。
 *
 * 冲突检测由调用方完成（它才持有授权信息：**其他组织公开的同名技能不算冲突**，只有当前组织
 * 已有的同名资源才算），本模块只按传入的冲突集合规划写入，并在任一环节失败时回滚文件与资源行。
 */
export async function importSkillDirectories(input: {
  organizationId: string;
  files: UploadSkillFile[];
  conflicts: readonly ImportSkillsConflict[];
  strategy?: ImportConflictStrategy;
  onSkillWritten?: (info: { name: string; description: string; path: string }) => Promise<void>;
  onRollbackCleanup?: (names: string[]) => Promise<void>;
  onRestoreComplete?: (names: string[]) => Promise<void>;
}): Promise<ImportSkillsResult> {
  const grouped = groupUploadFilesForImport(input.files);
  const root = getGlobalSkillsDir();
  const targetDir = skillOrganizationDir(input.organizationId);
  const { conflicts, strategy } = input;

  if (conflicts.length > 0 && !strategy) {
    return { imported: [], skipped: [], conflicts: [...conflicts] };
  }

  const { pendingEntries, skipped } = _deps.skillFs.resolveImportPlan(grouped, [...conflicts], strategy);

  if (pendingEntries.length === 0) {
    return { imported: [], skipped, conflicts: [] };
  }

  const overwriteNames = new Set(
    pendingEntries.filter(([name]) => conflicts.some((conflict) => conflict.name === name)).map(([name]) => name),
  );

  const result = await executeImportCore(
    targetDir,
    pendingEntries,
    [...overwriteNames],
    "rcs-skill-import-",
    undefined,
    // onSkillWritten: 写入文件后同步归档与资源行
    async (info) => {
      await _deps.skillFs.buildSkillArchive(
        _deps.skillFs.getSkillSourceDir(root, input.organizationId, info.name),
        _deps.skillFs.getSkillArchivePath(root, input.organizationId, info.name),
      );
      if (input.onSkillWritten) await input.onSkillWritten(info);
    },
    // onRollbackCleanup: 回滚时清理已尝试写入的资源行与归档
    async (names) => {
      if (input.onRollbackCleanup) await input.onRollbackCleanup(names);
      await Promise.all(names.map((name) => _deps.skillFs.deleteSkillArchive(root, input.organizationId, name)));
    },
    async (names) => {
      await Promise.all(
        names.map((name) =>
          _deps.skillFs.buildSkillArchive(
            _deps.skillFs.getSkillSourceDir(root, input.organizationId, name),
            _deps.skillFs.getSkillArchivePath(root, input.organizationId, name),
          ),
        ),
      );
      if (input.onRestoreComplete) await input.onRestoreComplete(names);
    },
  );

  return { ...result, skipped };
}
