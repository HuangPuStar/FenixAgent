/**
 * Workflow 文件系统操作。
 *
 * 所有工作流 YAML 文件存储在 <cwd>/.agents/workflows/<workflowId>/ 下。
 * 按项目目录隔离，不需要 organizationId 层级。
 *
 * 注意：readYamlFile 使用 Bun.file() 作为主读取路径，避免 node:fs/promises
 * 在 Bun 运行时下的同步/异步不一致问题。fallback 到 node:fs/promises readFile。
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 工作流文件存储根目录 */
export const WORKFLOW_BASE_DIR = join(process.cwd(), ".agents", "workflows");

/** 拼接工作流目录绝对路径 */
export function buildStoragePath(baseDir: string, _organizationId: string, workflowId: string): string {
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
 * 扫描文件系统中可恢复的孤立工作流目录。
 * 返回在文件系统中存在但不在 excludeIds 集合中的 workflowId 列表。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listRecoverable(
  baseDir: string,
  _organizationId: string,
  excludeIds: Set<string>,
): Promise<string[]> {
  if (!existsSync(baseDir)) return [];

  const entries = await readdir(baseDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  return dirs.filter((id) => UUID_RE.test(id) && !excludeIds.has(id));
}
