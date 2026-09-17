import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an executable command to its full path.
 * 1. Check project-local node_modules/.bin first
 * 2. Fall back to PATH entries
 * 3. Fall back to system `which`/`where`
 */
export function resolveExecutable(command: string): string {
  // 1. Check project-local node_modules/.bin first
  const localBin = join(process.cwd(), "node_modules", ".bin", command);
  if (isExecutable(localBin)) {
    return localBin;
  }

  // 2. Walk PATH entries
  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  // 3. Fall back to system which/where
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const result = execSync(`${which} ${command}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (result) return result.split("\n")[0].trim();
  } catch {}

  throw new Error(`Required executable not found: ${command}`);
}
