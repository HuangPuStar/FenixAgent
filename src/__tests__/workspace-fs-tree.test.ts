import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, listPathsRecursive, mkdirp, renamePath, shouldHideEntry } from "../services/workspace-fs";

describe("workspace-fs tree utilities", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ws-fs-test-"));
    await mkdir(join(baseDir, "user", "sub", "nested"), { recursive: true });
    await writeFile(join(baseDir, "user", "a.txt"), "hello");
    await writeFile(join(baseDir, "user", "sub", "b.txt"), "world");
    await writeFile(join(baseDir, "user", "sub", "nested", "c.txt"), "deep");
    await mkdir(join(baseDir, "user", ".opencode"), { recursive: true });
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  // listPathsRecursive 递归路径列表
  test("listPathsRecursive returns all user/ paths", async () => {
    const entries = await listPathsRecursive(baseDir);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("user/a.txt");
    expect(paths).toContain("user/sub/b.txt");
    expect(paths).toContain("user/sub/nested/c.txt");
    // .opencode 应被黑名单过滤
    expect(paths.some((p) => p.includes(".opencode"))).toBe(false);
  });

  // listPathsRecursive 目录以 / 结尾
  test("listPathsRecursive directories end with /", async () => {
    const entries = await listPathsRecursive(baseDir);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("user/");
    expect(paths).toContain("user/sub/");
    expect(paths).toContain("user/sub/nested/");
  });

  // listPathsRecursive 空 workspace 目录返回空数组
  test("listPathsRecursive returns empty for empty workspace dir", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "ws-fs-empty-"));
    const paths = await listPathsRecursive(emptyDir);
    expect(paths).toEqual([]);
    await rm(emptyDir, { recursive: true, force: true });
  });

  // renamePath 重命名文件
  test("renamePath renames a file", async () => {
    const src = join(baseDir, "user", "a.txt");
    const dst = join(baseDir, "user", "a-renamed.txt");
    await renamePath(src, dst);
    await expect(stat(src)).rejects.toThrow();
    await expect(stat(dst)).resolves.toBeDefined();
    await renamePath(dst, src);
  });

  // renamePath 重命名目录
  test("renamePath renames a directory", async () => {
    const src = join(baseDir, "user", "sub");
    const dst = join(baseDir, "user", "sub-renamed");
    await renamePath(src, dst);
    await expect(stat(src)).rejects.toThrow();
    const entries = await readdir(join(baseDir, "user", "sub-renamed"));
    expect(entries.length).toBeGreaterThan(0);
    await renamePath(dst, src);
  });

  // mkdirp 递归创建目录
  test("mkdirp creates nested directory", async () => {
    const newDir = join(baseDir, "user", "new", "deep", "dir");
    await mkdirp(newDir);
    await expect(stat(newDir)).resolves.toBeDefined();
    await rm(join(baseDir, "user", "new"), { recursive: true, force: true });
  });
});

describe("workspace-fs blacklist filtering", () => {
  // shouldHideEntry 对已知黑名单名称返回 true
  test("shouldHideEntry returns true for known blacklist names", () => {
    expect(shouldHideEntry("any-path/node_modules", "node_modules")).toBe(true);
    expect(shouldHideEntry("any-path/.git", ".git")).toBe(true);
    expect(shouldHideEntry("any-path/dist", "dist")).toBe(true);
    expect(shouldHideEntry("any-path/build", "build")).toBe(true);
    expect(shouldHideEntry("any-path/__pycache__", "__pycache__")).toBe(true);
    expect(shouldHideEntry("any-path/.idea", ".idea")).toBe(true);
    expect(shouldHideEntry("any-path/.vscode", ".vscode")).toBe(true);
    expect(shouldHideEntry("any-path/coverage", "coverage")).toBe(true);
    expect(shouldHideEntry("any-path/.opencode", ".opencode")).toBe(true);
  });

  // shouldHideEntry 对非黑名单名称返回 false
  test("shouldHideEntry returns false for non-blacklist names", () => {
    expect(shouldHideEntry("any-path/src", "src")).toBe(false);
    expect(shouldHideEntry("any-path/test", "test")).toBe(false);
    expect(shouldHideEntry("any-path/user", "user")).toBe(false);
    expect(shouldHideEntry("any-path/public", "public")).toBe(false);
    expect(shouldHideEntry("any-path/package.json", "package.json")).toBe(false);
  });

  let blacklistDir: string;

  beforeAll(async () => {
    blacklistDir = await mkdtemp(join(tmpdir(), "ws-bl-test-"));
    // 创建正常目录和文件
    await mkdir(join(blacklistDir, "user", "src"), { recursive: true });
    await writeFile(join(blacklistDir, "user", "src", "index.ts"), "hello");
    await writeFile(join(blacklistDir, "user", "README.md"), "# test");
    // 创建黑名单目录
    await mkdir(join(blacklistDir, "user", "node_modules"), { recursive: true });
    await writeFile(join(blacklistDir, "user", "node_modules", "pkg.js"), "dummy");
    await mkdir(join(blacklistDir, "user", "node_modules", ".cache"), { recursive: true });
    await mkdir(join(blacklistDir, "user", ".git"), { recursive: true });
    await writeFile(join(blacklistDir, "user", ".git", "config"), "git");
    await mkdir(join(blacklistDir, "user", "dist"), { recursive: true });
    await writeFile(join(blacklistDir, "user", "dist", "bundle.js"), "bundle");
  });

  afterAll(async () => {
    await rm(blacklistDir, { recursive: true, force: true });
  });

  // listPathsRecursive 过滤 node_modules 目录
  test("listPathsRecursive filters out node_modules", async () => {
    const entries = await listPathsRecursive(blacklistDir);
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  // listPathsRecursive 过滤 .git 目录
  test("listPathsRecursive filters out .git", async () => {
    const entries = await listPathsRecursive(blacklistDir);
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
  });

  // listPathsRecursive 过滤 dist 目录
  test("listPathsRecursive filters out dist", async () => {
    const entries = await listPathsRecursive(blacklistDir);
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.includes("dist"))).toBe(false);
  });

  // listPathsRecursive 仍返回非黑名单路径
  test("listPathsRecursive still returns non-blacklisted paths", async () => {
    const entries = await listPathsRecursive(blacklistDir);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("user/");
    expect(paths).toContain("user/src/");
    expect(paths).toContain("user/src/index.ts");
    expect(paths).toContain("user/README.md");
  });

  // listDirectory 过滤黑名单目录
  test("listDirectory filters out blacklisted directories from listing", async () => {
    const userDir = join(blacklistDir, "user");
    const workspaceDir = blacklistDir;
    const entries = await listDirectory(userDir, userDir, workspaceDir);
    const names = entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("dist");
  });
});
