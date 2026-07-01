import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTABLE_FILE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 判断给定路径是否存在且具备执行权限。
 */
export function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成从给定目录逐级向上搜索的目录列表。
 */
function listAncestorDirs(startDir: string): string[] {
  const directories: string[] = [];
  let currentDir = resolve(startDir);

  while (true) {
    directories.push(currentDir);
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return directories;
    }
    currentDir = parentDir;
  }
}

/**
 * 解析命令对应的可执行文件路径。
 *
 * 优先使用 PATH 上的全局安装版本，确保与远程 machine 侧（resolve-executable.ts）使用同一版本；
 * 避免本地 node_modules 中过旧版本（如 1.15.10）与全局版本（如 1.17.12）行为不一致，
 * 导致 ACP prompt 返回空响应等兼容性问题。
 * 若 PATH 中未找到，再回退到工作区内的 `node_modules/.bin`。
 */
export function resolveExecutable(command: string): string {
  // 1. 优先使用 which/where 查找 PATH 上的全局版本（跳过 node_modules/.bin 避免锁定项目内旧版本）
  let resolvedGlobal = "";
  try {
    const whichCommand = process.platform === "win32" ? "where" : "which";
    const result = execSync(`${whichCommand} -a ${command}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const candidates = result
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    // 跳过 node_modules/.bin 中的版本，优先使用系统/全局安装的版本
    for (const candidate of candidates) {
      if (candidate.includes("node_modules/.bin")) continue;
      resolvedGlobal = candidate;
      console.log(`[resolveExecutable] found "${command}" via which (global): ${resolvedGlobal}`);
      return resolvedGlobal;
    }
  } catch {
    // 忽略 which/where 失败
  }

  // 2. 回退：扫描 PATH 但排除 node_modules/.bin（避免锁定项目内旧版本）
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    if (entry.includes("node_modules/.bin")) continue;
    const candidate = join(entry, command);
    if (isExecutable(candidate)) {
      console.log(`[resolveExecutable] found "${command}" via PATH (non-node_modules): ${candidate}`);
      return candidate;
    }
  }

  // 3. 如果全局版本都找不到，才回退到 node_modules/.bin（兜底）
  const searchRoots = new Set<string>([...listAncestorDirs(process.cwd()), ...listAncestorDirs(EXECUTABLE_FILE_DIR)]);
  for (const rootDir of searchRoots) {
    const localBin = join(rootDir, "node_modules", ".bin", command);
    if (isExecutable(localBin)) {
      console.log(`[resolveExecutable] found "${command}" via node_modules/.bin (fallback): ${localBin}`);
      return localBin;
    }
  }

  throw new Error(`Required executable not found: ${command}`);
}
