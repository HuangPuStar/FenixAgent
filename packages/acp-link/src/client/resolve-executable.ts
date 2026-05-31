import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function resolveExecutable(command: string): string {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  try {
    const whichCommand = process.platform === "win32" ? "where" : "which";
    return execSync(`${whichCommand} ${command}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/, 1)[0]
      .trim();
  } catch {
    throw new Error(`Required executable not found: ${command}`);
  }
}
