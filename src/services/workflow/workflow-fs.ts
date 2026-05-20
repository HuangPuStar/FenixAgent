/**
 * Workflow 文件系统操作。
 *
 * 所有工作流 YAML 文件存储在 <cwd>/.agents/workflows/<workflowId>/ 下。
 * 按项目目录隔离，不需要 teamId 层级。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

/** 读取 YAML 文件，不存在返回 null */
export async function readYamlFile(dir: string, fileName: string): Promise<string | null> {
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf-8");
}

/**
 * 扫描文件系统中可恢复的孤立工作流目录。
 * 返回在文件系统中存在但不在 excludeIds 集合中的 workflowId 列表。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listRecoverable(baseDir: string, _organizationId: string, excludeIds: Set<string>): Promise<string[]> {
  if (!existsSync(baseDir)) return [];

  const entries = await readdir(baseDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  return dirs.filter((id) => UUID_RE.test(id) && !excludeIds.has(id));
}
