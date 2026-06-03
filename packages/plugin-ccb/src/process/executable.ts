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
 * 优先使用工作区内的 `node_modules/.bin`，尽量锁定到项目声明的依赖版本；
 * 若本地未安装，再回退到 PATH 和 `which`/`where`，兼容用户已全局安装命令的场景。
 */
export function resolveExecutable(command: string): string {
  const searchRoots = new Set<string>([...listAncestorDirs(process.cwd()), ...listAncestorDirs(EXECUTABLE_FILE_DIR)]);

  for (const rootDir of searchRoots) {
    const localBin = join(rootDir, "node_modules", ".bin", command);
    if (isExecutable(localBin)) {
      return localBin;
    }
  }

  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  try {
    const whichCommand = process.platform === "win32" ? "where" : "which";
    const result = execSync(`${whichCommand} ${command}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (result) {
      return result.split(/\r?\n/, 1)[0].trim();
    }
  } catch {
    // 忽略 which/where 失败，统一在下方抛出缺失错误。
  }

  throw new Error(`Required executable not found: ${command}`);
}
