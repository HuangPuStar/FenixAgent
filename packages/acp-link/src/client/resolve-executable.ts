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
      // not found or not executable, try next entry
    }
  }

  const whichCommand = process.platform === "win32" ? "where" : "which";
  let firstLine: string | undefined;
  try {
    firstLine = execSync(`${whichCommand} ${command}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/, 1)
      // 本包 tsconfig 开了 noUncheckedIndexedAccess，`[0]` 的类型是 `string | undefined`。
      .at(0)
      ?.trim();
  } catch {
    // which/where 执行失败（命令不存在）与「查到了但输出为空」等价，统一走下方失败路径。
  }

  // 空结果不得当成解析出的可执行文件路径返回（否则调用方拿到空串去 spawn）。
  if (!firstLine) throw new Error(`Required executable not found: ${command}`);
  return firstLine;
}
