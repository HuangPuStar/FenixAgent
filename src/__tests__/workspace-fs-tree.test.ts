import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPathsRecursive, mkdirp, renamePath } from "../services/workspace-fs";

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
    const paths = await listPathsRecursive(baseDir);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("sub/b.txt");
    expect(paths).toContain("sub/nested/c.txt");
    // .opencode 应被过滤
    expect(paths.some((p) => p.includes(".opencode"))).toBe(false);
  });

  // listPathsRecursive 目录以 / 结尾
  test("listPathsRecursive directories end with /", async () => {
    const paths = await listPathsRecursive(baseDir);
    expect(paths).toContain("sub/");
    expect(paths).toContain("sub/nested/");
  });

  // listPathsRecursive 空 user 目录返回空数组
  test("listPathsRecursive returns empty for empty user dir", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "ws-fs-empty-"));
    await mkdir(join(emptyDir, "user"), { recursive: true });
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
