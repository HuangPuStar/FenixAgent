import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorkspaceFiles } from "../workspace-files";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// 配置含凭据，协议中的文件路径必须限定在本次 workspace 内。
test("拒绝绝对路径与父目录穿越", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-files-"));
  roots.push(root);
  for (const path of ["../outside.json", "/outside.json", "."]) {
    await expect(writeWorkspaceFiles(root, [{ path, content: {} }])).rejects.toThrow("工作区托管文件路径非法");
  }
});

// 用户可编辑 workspace，不能利用配置目录的符号链接把平台凭据写到其它目录。
test("拒绝托管目录符号链接", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-files-"));
  const outside = await mkdtemp(join(tmpdir(), "workspace-outside-"));
  roots.push(root, outside);
  await symlink(outside, join(root, ".hindsight"));
  await expect(writeWorkspaceFiles(root, [{ path: ".hindsight/workspace.json", content: {} }])).rejects.toThrow(
    "工作区托管目录不能是符号链接",
  );
  await expect(readFile(join(outside, "workspace.json"))).rejects.toThrow();
});
