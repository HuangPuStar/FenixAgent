import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveWorkspacePath } from "../services/workspace-resolver";

describe("resolveWorkspacePath", () => {
  // WORKSPACE_ROOT 未设置时使用 cwd/workspaces
  test("默认使用 cwd/workspaces 作为根目录", () => {
    const original = process.env.WORKSPACE_ROOT;
    delete process.env.WORKSPACE_ROOT;

    const result = resolveWorkspacePath("org-1", "user-1");
    expect(result).toBe(join(process.cwd(), "workspaces", "org-1", "user-1"));

    if (original !== undefined) process.env.WORKSPACE_ROOT = original;
  });

  // WORKSPACE_ROOT 已设置时使用配置值
  test("WORKSPACE_ROOT 已设置时使用配置值", () => {
    const original = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = "/data/rcs";

    const result = resolveWorkspacePath("org-1", "user-1");
    expect(result).toBe("/data/rcs/org-1/user-1");

    if (original !== undefined) process.env.WORKSPACE_ROOT = original;
    else delete process.env.WORKSPACE_ROOT;
  });

  // 不同 orgId + userId 组合产生不同路径
  test("不同 orgId + userId 产生不同路径", () => {
    const original = process.env.WORKSPACE_ROOT;
    delete process.env.WORKSPACE_ROOT;

    const path1 = resolveWorkspacePath("org-a", "user-1");
    const path2 = resolveWorkspacePath("org-a", "user-2");
    const path3 = resolveWorkspacePath("org-b", "user-1");

    expect(path1).not.toBe(path2);
    expect(path1).not.toBe(path3);
    expect(path2).not.toBe(path3);

    if (original !== undefined) process.env.WORKSPACE_ROOT = original;
  });
});
