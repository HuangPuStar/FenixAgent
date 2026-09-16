/**
 * Workflow 文件系统操作。
 *
 * 文件存储分层隔离：<baseDir>/<organizationId>/<workflowId>/。
 * organizationId 是多租户隔离的关键，必须在路径中体现，否则 recover 接口会跨组织泄露。
 *
 * 历史数据兼容：迁移前路径为 <baseDir>/<workflowId>/，读取时若新路径不存在则回退到旧路径（仅用于读取，写入永远走新路径）。
 *
 * 注意：readYamlFile 使用 Bun.file() 作为主读取路径，避免 node:fs/promises
 * 在 Bun 运行时下的同步/异步不一致问题。fallback 到 node:fs/promises readFile。
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 工作流文件存储根目录 */
export const WORKFLOW_BASE_DIR = join(process.cwd(), ".agents", "workflows");

/** 拼接工作流目录绝对路径（带 organizationId 隔离） */
export function buildStoragePath(baseDir: string, organizationId: string, workflowId: string): string {
  return join(baseDir, organizationId, workflowId);
}

/** 拼接组织级目录绝对路径 */
export function buildOrgDir(baseDir: string, organizationId: string): string {
  return join(baseDir, organizationId);
}

/** 历史路径（迁移前无 organizationId 层级） — 仅用于读取兼容 */
function legacyStoragePath(baseDir: string, workflowId: string): string {
  return join(baseDir, workflowId);
}

/** 确保工作流目录存在 */
export async function ensureWorkflowDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 写入 YAML 文件 */
export async function writeYamlFile(dir: string, fileName: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content, "utf-8");
}

/** 读取 YAML 文件，不存在或读取失败返回 null。
 *
 * 优先使用 Bun.file() 原生 API（避免 node:fs/promises 在 Bun 下的潜在不一致），
 * 失败时 fallback 到 node:fs/promises readFile。
 */
export async function readYamlFile(dir: string, fileName: string): Promise<string | null> {
  const filePath = join(dir, fileName);

  // 主路径：Bun 原生文件 API
  try {
    const file = Bun.file(filePath);
    // size 为 0 可能是空文件或不存在，用 exists() 区分
    if (!(await file.exists())) return null;
    return await file.text();
  } catch (err) {
    console.warn(`[workflow-fs] Bun.file() failed for ${filePath}: ${(err as Error).message}`);
  }

  // fallback：node:fs/promises
  try {
    return await readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return null;
    }
    // 非 ENOENT 的错误打印完整堆栈以便排查
    console.error(`[workflow-fs] readFile failed for ${filePath}:`, err);
    return null;
  }
}

/**
 * 扫描指定组织文件系统中可恢复的孤立工作流目录。
 *
 * 多租户关键：只扫描 `<baseDir>/<organizationId>/` 子目录，绝不跨越到其他组织。
 *
 * 历史数据兼容：若 organizationId 子目录不存在，回退扫描旧路径 `<baseDir>/<workflowId>/`，
 * 仅返回 UUID 格式的目录名且不在 excludeIds 集合中的项。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listRecoverable(
  baseDir: string,
  organizationId: string,
  excludeIds: Set<string>,
): Promise<string[]> {
  const orgDir = buildOrgDir(baseDir, organizationId);
  const legacyBase = baseDir;

  // 收集新路径下的可恢复 workflow
  const result: string[] = [];
  const seen = new Set<string>();

  if (existsSync(orgDir)) {
    const entries = await readdir(orgDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const id of dirs) {
      if (UUID_RE.test(id) && !excludeIds.has(id) && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
  }

  // 兼容旧路径：迁移前文件直接在 <baseDir>/<workflowId>/ 下
  if (existsSync(legacyBase)) {
    const entries = await readdir(legacyBase, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const id of dirs) {
      // 排除作为组织目录的 32 位 hex 串；只看 UUID 形态
      if (UUID_RE.test(id) && !excludeIds.has(id) && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
  }

  return result;
}

/** 兼容旧路径：迁移前 workflow 直接在 baseDir/<workflowId>/ 下，迁移后是 baseDir/<orgId>/<workflowId>/。
 * 读取时若新路径不存在则尝试旧路径。返回第一个命中的目录，或 null。 */
export async function resolveStorageDir(
  baseDir: string,
  organizationId: string,
  workflowId: string,
): Promise<string | null> {
  const newPath = buildStoragePath(baseDir, organizationId, workflowId);
  if (existsSync(newPath)) return newPath;
  const oldPath = legacyStoragePath(baseDir, workflowId);
  if (existsSync(oldPath)) return oldPath;
  return null;
}
