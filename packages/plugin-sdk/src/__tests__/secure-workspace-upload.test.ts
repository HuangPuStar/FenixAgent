import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadWorkspaceFile, uploadWorkspaceFileExclusive } from "../secure-workspace-upload";

// 原子覆盖必须保留已有文件的普通权限位，新建文件继续保持仅当前用户可读写。
test.each([0o755, 0o640])("overwrite preserves existing permissions %o", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "secure-upload-mode-"));
  try {
    const path = join(root, "existing.txt");
    await writeFile(path, "before");
    await chmod(path, mode);
    await uploadWorkspaceFile(root, "existing.txt", Buffer.from("after"), { overwrite: true });
    expect((await stat(path)).mode & 0o777).toBe(mode);
    expect(await readFile(path, "utf8")).toBe("after");
    await uploadWorkspaceFile(root, "new.txt", Buffer.from("private"), { overwrite: true });
    expect((await stat(join(root, "new.txt"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 条件覆盖必须比较真实内容，并让重试回执先于已过时的条件执行。
test("conditional upload detects equal-size edits and replays a committed operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "secure-version-"));
  try {
    const bytes = (value: string) => new TextEncoder().encode(value);
    await writeFile(join(root, "file.txt"), "first");
    await chmod(join(root, "file.txt"), 0o755);
    const first = "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e";
    const result = await uploadWorkspaceFile(root, "file.txt", bytes("saved"), {
      overwrite: true,
      expectedVersion: first,
      opId: "save-1",
    });
    expect((await stat(join(root, "file.txt"))).mode & 0o777).toBe(0o755);
    await writeFile(join(root, "file.txt"), "other");
    await expect(
      uploadWorkspaceFile(root, "file.txt", bytes("again"), { overwrite: true, expectedVersion: result.version }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(
      await uploadWorkspaceFile(root, "file.txt", bytes("saved"), {
        overwrite: true,
        expectedVersion: first,
        opId: "save-1",
      }),
    ).toEqual(result);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("other");
    await expect(
      uploadWorkspaceFile(root, "file.txt", bytes("changed"), {
        overwrite: true,
        expectedVersion: first,
        opId: "save-1",
      }),
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 删除、类型替换和最后一刻 symlink 切换均不得让条件保存重建或越界。
test("conditional upload rejects missing and symlink targets at commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "secure-condition-"));
  try {
    const emptyVersion = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    await expect(
      uploadWorkspaceFile(root, "missing.txt", new Uint8Array(), { overwrite: true, expectedVersion: emptyVersion }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await writeFile(join(root, "file.txt"), "");
    await writeFile(join(root, "outside.txt"), "outside");
    await expect(
      uploadWorkspaceFile(
        root,
        "file.txt",
        new Uint8Array(),
        { overwrite: true, expectedVersion: emptyVersion },
        async () => {
          await rm(join(root, "file.txt"));
          await symlink(join(root, "outside.txt"), join(root, "file.txt"));
        },
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("outside");
    const result = await uploadWorkspaceFile(root, "empty.txt", new Uint8Array(), { overwrite: true });
    expect(result.version).toBe(emptyVersion);
    await expect(uploadWorkspaceFile(root, "empty.txt", new Uint8Array())).rejects.toMatchObject({ code: "EEXIST" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
