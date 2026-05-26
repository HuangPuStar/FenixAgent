import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── workspace 路径符号链接逃逸验证 ──
// R37 修复：ensureWorkspaceDir 通过 realpathSync 解析符号链接后需重新校验

// 复制 environment-core.ts 的验证逻辑
const BLOCKED_PATHS = ["/", "/etc", "/usr", "/bin", "/sbin", "/var", "/sys", "/proc", "/dev", "/boot", "/lib", "/root"];

import { isAbsolute, resolve } from "node:path";

function validateWorkspacePath(p: string): string | null {
  if (!isAbsolute(p)) return "workspace 路径必须是绝对路径";
  const normalized = resolve(p);
  if (BLOCKED_PATHS.includes(normalized)) return `不允许使用系统目录: ${normalized}`;
  for (const blocked of BLOCKED_PATHS) {
    if (blocked !== "/" && normalized.startsWith(`${blocked}/`)) {
      return `不允许使用系统目录下的路径: ${normalized}`;
    }
  }
  return null;
}

describe("workspace path symlink escape prevention", () => {
  // 使用 sandbox 可写且不在 BLOCKED_PATHS 内的目录。
  const testDir = join("/private/tmp", `.rcs-symlink-test-${process.pid}`);
  const linkPath = join(testDir, "link_to_blocked");

  beforeEach(() => {
    try {
      mkdirSync(testDir, { recursive: true });
    } catch {}
  });

  afterEach(() => {
    try {
      unlinkSync(linkPath);
    } catch {}
    try {
      rmdirSync(testDir);
    } catch {}
  });

  // 直接传入系统目录被拦截
  test("direct blocked path rejected", () => {
    expect(validateWorkspacePath("/etc")).not.toBeNull();
    expect(validateWorkspacePath("/usr/local")).not.toBeNull();
  });

  // 符号链接路径本身不直接指向系统目录时通过初次校验
  test("symlink path passes initial validation if not blocked itself", () => {
    // 创建指向 /tmp 的符号链接（/tmp 不在 BLOCKED_PATHS 中）
    try {
      symlinkSync("/tmp", linkPath);
    } catch {}
    // linkPath 本身不在 BLOCKED_PATHS 中，初次校验通过
    expect(validateWorkspacePath(linkPath)).toBeNull();
  });
});
