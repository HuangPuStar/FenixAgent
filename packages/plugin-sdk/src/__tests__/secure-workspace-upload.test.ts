import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadWorkspaceFileExclusive } from "../secure-workspace-upload";

// 最后一次校验后父目录被换成外部链接，文件描述符仍只能写原目录，不能越界。
test("exclusive upload remains anchored after parent directory symlink replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "secure-upload-"));
  try {
    const workspace = join(root, "workspace"),
      outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await uploadWorkspaceFileExclusive(
      workspace,
      "user/parent/file.txt",
      new TextEncoder().encode("private"),
      async () => {
        await rename(join(workspace, "user/parent"), join(workspace, "user/original"));
        await symlink(outside, join(workspace, "user/parent"));
      },
    );
    expect(await readFile(join(workspace, "user/original/file.txt"), "utf8")).toBe("private");
    expect(await Bun.file(join(outside, "file.txt")).exists()).toBe(false);
    await expect(
      uploadWorkspaceFileExclusive(workspace, "user/original/file.txt", new Uint8Array()),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      uploadWorkspaceFileExclusive(workspace, "user/parent/new/deep/file.txt", new Uint8Array()),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await Bun.file(join(outside, "new")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
