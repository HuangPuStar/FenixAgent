# skill.ts 文件系统 I/O 分离 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `skill.ts`（554 行）中的文件系统操作（frontmatter 解析、目录扫描、导入/导出）提取为独立的 `skill-fs.ts`，消除全局 Skill 和 Workspace Skill 导入逻辑之间约 85 行的代码重复。

**Architecture:** `skill-fs.ts` 封装所有文件系统操作，提供参数化的核心函数（接受目标目录作为参数）。`skill.ts` 保留编排逻辑（调用 config-pg + skill-fs），仅负责全局/Workspace 的入口调度。两个 `import*Directories` 函数共享 `skill-fs.ts` 中的同一个核心导入函数，通过策略对象区分"PG 元数据同步"和"纯文件系统"两种模式。

**Tech Stack:** Node.js fs/promises、TypeScript

---

## 受影响文件总览

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/services/skill-fs.ts` | 新建 | 文件系统操作（frontmatter、目录扫描、导入核心逻辑） |
| `src/services/skill.ts` | 修改 | 移除文件系统操作函数，改为调用 skill-fs.ts；去重导入逻辑 |

---

### Task 1: 创建 skill-fs.ts — 提取文件系统工具函数

**Files:**
- Create: `src/services/skill-fs.ts`

当前 `skill.ts` 中以下纯函数不依赖任何外部状态或 PG，可以直接提取：

- `parseFrontmatter`（第 92-101 行）
- `buildSkillMd`（第 103-107 行）
- `normalizeUploadPath`（第 115-127 行）
- `groupUploadFiles`（第 129-151 行）
- `createSkillValidationError`（第 109-113 行）
- `listSkillsFromDir`（第 348-360 行）

- [ ] **Step 1: 创建 skill-fs.ts，包含所有文件系统工具函数**

创建 `src/services/skill-fs.ts`：

```typescript
import { readdir, readFile, writeFile, mkdir, rm, cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ────────────────────────────────────────────
// 共享类型
// ────────────────────────────────────────────

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

// ────────────────────────────────────────────
// 纯函数工具
// ────────────────────────────────────────────

export function createSkillValidationError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "VALIDATION_ERROR";
  return error;
}

export function parseFrontmatter(raw: string): { metadata: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { metadata: {}, content: raw };
  const metadata: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { metadata, content: match[2] };
}

export function buildSkillMd(name: string, description: string, content: string, metadata?: Record<string, string>): string {
  const meta: Record<string, string> = { name, description, ...(metadata ?? {}) };
  const frontmatter = Object.entries(meta).map(([k, v]) => `${k}: "${v}"`).join("\n");
  return `---\n${frontmatter}\n---\n${content}`;
}

export function normalizeUploadPath(relativePath: string): string {
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

export function groupUploadFiles(files: UploadSkillFile[]): Map<string, UploadSkillFile[]> {
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
// 目录扫描
// ────────────────────────────────────────────

export async function listSkillsFromDir(baseDir: string, enabled = true): Promise<SkillInfo[]> {
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

export async function readSkillDetailFromMd(mdPath: string): Promise<{ metadata: Record<string, string>; content: string } | null> {
  if (!existsSync(mdPath)) return null;
  const raw = await readFile(mdPath, "utf-8");
  return parseFrontmatter(raw);
}

export async function writeSkillMd(skillDir: string, name: string, description: string, content: string, metadata?: Record<string, string>): Promise<string> {
  await mkdir(skillDir, { recursive: true });
  const mdPath = join(skillDir, "SKILL.md");
  const mdContent = buildSkillMd(name, description, content, metadata);
  await writeFile(mdPath, mdContent, "utf-8");
  return mdPath;
}

export async function deleteSkillDir(skillDir: string): Promise<void> {
  if (existsSync(skillDir)) {
    await rm(skillDir, { recursive: true, force: true });
  }
}

// ────────────────────────────────────────────
// 通用导入核心逻辑
// ────────────────────────────────────────────

export interface ConflictCheckResult {
  conflicts: ImportSkillsConflict[];
  pendingEntries: [string, UploadSkillFile[]][];
  skipped: string[];
}

/**
 * 检查导入冲突并确定待处理条目。
 * 两种模式的冲突检测逻辑不同（PG 查询 vs 文件系统检查），由调用者传入冲突列表。
 */
export function resolveImportPlan(
  grouped: Map<string, UploadSkillFile[]>,
  existingConflicts: ImportSkillsConflict[],
  strategy?: ImportConflictStrategy,
): ConflictCheckResult {
  if (existingConflicts.length > 0 && !strategy) {
    return { conflicts: existingConflicts, pendingEntries: [], skipped: [] };
  }

  const conflictNames = new Set(existingConflicts.map((item) => item.name));
  const skipped = strategy === "ignore" ? [...conflictNames] : [];
  const pendingEntries = [...grouped.entries()].filter(
    ([name]) => strategy !== "ignore" || !conflictNames.has(name),
  );

  if (pendingEntries.length === 0) {
    return { conflicts: [], pendingEntries: [], skipped };
  }

  return { conflicts: [], pendingEntries, skipped };
}

/**
 * 将文件写入目标目录。
 * 返回成功写入的 skill 名称列表。
 */
export async function writeImportFiles(
  targetDir: string,
  entries: [string, UploadSkillFile[]][],
): Promise<string[]> {
  const written: string[] = [];
  for (const [name, skillFiles] of entries) {
    const skillDir = join(targetDir, name);
    await mkdir(skillDir, { recursive: true });
    for (const file of skillFiles) {
      const targetPath = join(skillDir, normalizeUploadPath(file.relativePath));
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, "utf-8");
    }
    written.push(name);
  }
  return written;
}

/**
 * 读取写入后的 SKILL.md 元数据，构建 SkillInfo 列表。
 */
export async function buildImportedSkillInfos(
  targetDir: string,
  names: string[],
): Promise<SkillInfo[]> {
  const imported: SkillInfo[] = [];
  for (const name of names) {
    const mdPath = join(targetDir, name, "SKILL.md");
    const raw = await readFile(mdPath, "utf-8");
    const { metadata } = parseFrontmatter(raw);
    imported.push({ name, enabled: true, description: metadata.description ?? "", path: mdPath });
  }
  return imported;
}

/**
 * 备份指定目录下的 skill 目录。
 * 返回备份路径映射。
 */
export async function backupSkillDirs(
  backupRoot: string,
  targetDir: string,
  names: string[],
): Promise<Map<string, string | null>> {
  const snapshots = new Map<string, string | null>();
  await mkdir(backupRoot, { recursive: true });
  for (const name of names) {
    const skillDir = join(targetDir, name);
    if (existsSync(skillDir)) {
      const backupPath = join(backupRoot, name);
      await cp(skillDir, backupPath, { recursive: true });
      snapshots.set(name, backupPath);
    } else {
      snapshots.set(name, null);
    }
  }
  return snapshots;
}

/**
 * 清理写入的 skill 目录（错误恢复时使用）。
 */
export async function cleanupWrittenSkills(targetDir: string, names: string[]): Promise<void> {
  for (const name of names) {
    await deleteSkillDir(join(targetDir, name));
  }
}

/**
 * 从备份恢复 skill 目录。
 */
export async function restoreFromBackup(
  snapshots: Map<string, string | null>,
  targetDir: string,
): Promise<void> {
  for (const [name, backupPath] of snapshots) {
    if (backupPath && existsSync(backupPath)) {
      await cp(backupPath, join(targetDir, name), { recursive: true });
    }
  }
}

/**
 * 创建临时备份目录。
 */
export async function createBackupDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * 清理临时备份目录。
 */
export async function cleanupBackupDir(backupRoot: string): Promise<void> {
  await rm(backupRoot, { recursive: true, force: true });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/skill-fs.ts
git commit -m "refactor: 提取 skill 文件系统操作为 skill-fs.ts 独立模块"
```

---

### Task 2: 重写 skill.ts — 使用 skill-fs.ts 去重导入逻辑

**Files:**
- Modify: `src/services/skill.ts`

- [ ] **Step 1: 重写 skill.ts，移除重复代码**

将 `src/services/skill.ts` 替换为以下内容。关键改动：
1. 导入 `skill-fs.ts` 的工具函数替代内联实现
2. `importSkillDirectories` 和 `importWorkspaceSkillDirectories` 共享核心逻辑
3. 类型从 `skill-fs.ts` 重新导出

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as configPg from "./config/skill";
import {
  parseFrontmatter,
  buildSkillMd,
  listSkillsFromDir,
  readSkillDetailFromMd,
  writeSkillMd,
  deleteSkillDir,
  groupUploadFiles,
  resolveImportPlan,
  writeImportFiles,
  buildImportedSkillInfos,
  backupSkillDirs,
  cleanupWrittenSkills,
  restoreFromBackup,
  createBackupDir,
  cleanupBackupDir,
  createSkillValidationError,
} from "./skill-fs";
import type {
  SkillInfo,
  SkillDetail,
  UploadSkillFile,
  ImportConflictStrategy,
  ImportSkillsConflict,
  ImportSkillsResult,
} from "./skill-fs";

// 重新导出类型供外部使用
export type { SkillInfo, SkillDetail, UploadSkillFile, ImportConflictStrategy, ImportSkillsConflict, ImportSkillsResult };

export const OLD_SKILLS_DIR = join(homedir(), ".config", "opencode", "skills");
export const SKILLS_DIR = join(homedir(), ".agents", "skills");

export interface SkillMeta {
  name: string;
  description: string;
  [key: string]: string;
}

export type SkillSourceStatus = "online" | "offline" | "timeout";

export interface SkillSourceInfo {
  type: "global" | "workspace";
  id?: string;
  name: string;
  path: string;
  status: SkillSourceStatus;
  skills: SkillInfo[];
}

// ────────────────────────────────────────────
// 目录迁移
// ────────────────────────────────────────────

export async function migrateSkillsDir(): Promise<void> {
  const { mkdir, writeFile, rm, cp } = await import("node:fs/promises");
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

// ────────────────────────────────────────────
// 全局 Skill（PG 元数据 + 文件系统内容）
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
  const parsed = await readSkillDetailFromMd(contentPath);
  const fileMetadata = parsed?.metadata ?? {};

  return {
    name,
    description: meta.description ?? fileMetadata.description ?? "",
    content: parsed?.content ?? "",
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
  const contentPath = await writeSkillMd(join(SKILLS_DIR, name), name, data.description, data.content, data.metadata);

  await configPg.upsertSkill(userId, name, {
    description: data.description,
    contentPath,
    metadata: data.metadata,
    enabled: true,
  });

  return { name, enabled: true, description: data.description, path: contentPath };
}

export async function deleteSkill(userId: string, name: string): Promise<boolean> {
  await deleteSkillDir(join(SKILLS_DIR, name));
  return configPg.deleteSkill(userId, name);
}

export async function enableSkill(userId: string, name: string): Promise<boolean> {
  return configPg.enableSkill(userId, name);
}

export async function disableSkill(userId: string, name: string): Promise<boolean> {
  return configPg.disableSkill(userId, name);
}

// ────────────────────────────────────────────
// 全局 Skill 批量导入（PG 元数据 + 文件系统）
// ────────────────────────────────────────────

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

  // 冲突检测：查询 PG 元数据
  const conflicts: ImportSkillsConflict[] = [];
  for (const [name] of grouped) {
    if (!grouped.get(name)?.some((file) => file.relativePath === "SKILL.md")) {
      throw createSkillValidationError(`Skill "${name}" 缺少 SKILL.md`);
    }
    const existing = await configPg.getSkill(userId, name);
    if (existing) {
      conflicts.push({ name, enabled: existing.enabled, path: existing.contentPath ?? skillContentPath(name) });
    }
  }

  const plan = resolveImportPlan(grouped, conflicts, strategy);
  if (plan.pendingEntries.length === 0) {
    return { imported: [], skipped: plan.skipped, conflicts: plan.conflicts };
  }

  const backupRoot = await createBackupDir("rcs-skill-import-");
  const snapshots = new Map<string, string | null>();
  const attemptedNames: string[] = [];

  try {
    // 覆盖策略：备份并删除旧数据（文件 + PG）
    if (strategy === "overwrite") {
      const overwriteNames = plan.pendingEntries
        .filter(([name]) => conflicts.some((c) => c.name === name))
        .map(([name]) => name);
      const backedUp = await backupSkillDirs(backupRoot, SKILLS_DIR, overwriteNames);
      for (const [name, path] of backedUp) snapshots.set(name, path);
      for (const name of overwriteNames) {
        await deleteSkillDir(join(SKILLS_DIR, name));
        await configPg.deleteSkill(userId, name);
      }
    }

    // 写入文件
    const written = await writeImportFiles(SKILLS_DIR, plan.pendingEntries);
    attemptedNames.push(...written);

    // 同步 PG 元数据并构建结果
    const imported: SkillInfo[] = [];
    for (const name of written) {
      const mdPath = skillContentPath(name);
      const parsed = await readSkillDetailFromMd(mdPath);
      await configPg.upsertSkill(userId, name, {
        description: parsed?.metadata.description ?? "",
        contentPath: mdPath,
        enabled: true,
      });
      imported.push({ name, enabled: true, description: parsed?.metadata.description ?? "", path: mdPath });
    }

    return { imported, skipped: plan.skipped, conflicts: [] };
  } catch (error) {
    await cleanupWrittenSkills(SKILLS_DIR, attemptedNames);
    for (const name of attemptedNames) {
      await configPg.deleteSkill(userId, name).catch(() => {});
    }
    await restoreFromBackup(snapshots, SKILLS_DIR);
    throw error;
  } finally {
    await cleanupBackupDir(backupRoot);
  }
}

// ────────────────────────────────────────────
// Workspace Skill（纯文件系统，无 PG）
// ────────────────────────────────────────────

const WORKSPACE_SCAN_TIMEOUT_MS = 2000;

function getWorkspaceSkillDir(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

export async function listWorkspaceSkills(workspacePath: string): Promise<SkillInfo[]> {
  return listSkillsFromDir(getWorkspaceSkillDir(workspacePath));
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
  const mdPath = join(getWorkspaceSkillDir(workspacePath), name, "SKILL.md");
  const parsed = await readSkillDetailFromMd(mdPath);
  if (!parsed) return null;
  return {
    name,
    description: parsed.metadata.description ?? "",
    content: parsed.content,
    enabled: true,
    path: mdPath,
    metadata: Object.fromEntries(Object.entries(parsed.metadata).filter(([k]) => k !== "name" && k !== "description")),
  };
}

export async function setWorkspaceSkill(
  workspacePath: string,
  name: string,
  data: { description: string; content: string; metadata?: Record<string, string> },
): Promise<SkillInfo> {
  const skillsDir = getWorkspaceSkillDir(workspacePath);
  const mdPath = await writeSkillMd(join(skillsDir, name), name, data.description, data.content, data.metadata);
  return { name, enabled: true, description: data.description, path: mdPath };
}

export async function deleteWorkspaceSkill(workspacePath: string, name: string): Promise<boolean> {
  const skillDir = join(getWorkspaceSkillDir(workspacePath), name);
  if (!existsSync(skillDir)) return false;
  await deleteSkillDir(skillDir);
  return true;
}

// ────────────────────────────────────────────
// Workspace Skill 批量导入（纯文件系统）
// ────────────────────────────────────────────

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

  // 冲突检测：检查文件系统
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

  const plan = resolveImportPlan(grouped, conflicts, strategy);
  if (plan.pendingEntries.length === 0) {
    return { imported: [], skipped: plan.skipped, conflicts: plan.conflicts };
  }

  const backupRoot = await createBackupDir("rcs-ws-skill-import-");
  const snapshots = new Map<string, string | null>();
  const attemptedNames: string[] = [];

  try {
    if (strategy === "overwrite") {
      const overwriteNames = plan.pendingEntries
        .filter(([name]) => conflicts.some((c) => c.name === name))
        .map(([name]) => name);
      const backedUp = await backupSkillDirs(backupRoot, targetDir, overwriteNames);
      for (const [name, path] of backedUp) snapshots.set(name, path);
      for (const name of overwriteNames) {
        await deleteSkillDir(join(targetDir, name));
      }
    }

    const written = await writeImportFiles(targetDir, plan.pendingEntries);
    attemptedNames.push(...written);

    const imported = await buildImportedSkillInfos(targetDir, written);
    return { imported, skipped: plan.skipped, conflicts: [] };
  } catch (error) {
    await cleanupWrittenSkills(targetDir, attemptedNames);
    await restoreFromBackup(snapshots, targetDir);
    throw error;
  } finally {
    await cleanupBackupDir(backupRoot);
  }
}
```

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 3: 运行全量测试**

Run: `bun test src/__tests__/`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/skill.ts src/services/skill-fs.ts
git commit -m "refactor: skill.ts 文件系统操作提取为 skill-fs.ts，消除全局/Workspace 导入逻辑重复"
```

---

### Task 3: 验证去重效果

- [ ] **Step 1: 对比行数**

Run: `wc -l src/services/skill.ts src/services/skill-fs.ts`
Expected: skill.ts 约 280 行（从 554 行减少约 50%），skill-fs.ts 约 220 行。总计约 500 行，但重复代码已消除。

- [ ] **Step 2: 确认 skill-fs.ts 无 PG 依赖**

Run: `grep -n "configPg\|config-pg\|repositories\|db" src/services/skill-fs.ts`
Expected: 零匹配 — skill-fs.ts 完全不依赖 PG 或任何外部状态

- [ ] **Step 3: 确认 skill.ts 不再包含文件系统底层操作**

Run: `grep -n "function parseFrontmatter\|function buildSkillMd\|function normalizeUploadPath\|function groupUploadFiles" src/services/skill.ts`
Expected: 零匹配 — 这些函数已完全移至 skill-fs.ts
