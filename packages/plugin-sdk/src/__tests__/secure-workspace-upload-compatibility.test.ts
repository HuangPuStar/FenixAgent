import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadWorkspaceFile, uploadWorkspaceFileExclusive } from "../secure-workspace-upload";

// 旧 SDK 原语没有编辑器容量上限，返回值和同名拒绝语义也不能被新接口改变。
test("exclusive upload preserves its original size budget, void result and create-only behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-compat-size-"));
  try {
    const content = Buffer.alloc(92 * 1024 * 1024 + 1, 7);
    expect(await uploadWorkspaceFileExclusive(root, "legacy.bin", content)).toBeUndefined();
    expect((await stat(join(root, "legacy.bin"))).size).toBe(content.byteLength);
    const file = await open(join(root, "legacy.bin"), "r");
    try {
      const tail = Buffer.alloc(1);
      expect((await file.read(tail, 0, 1, content.byteLength - 1)).bytesRead).toBe(1);
      expect(tail[0]).toBe(7);
    } finally {
      await file.close();
    }
    await expect(uploadWorkspaceFileExclusive(root, "legacy.bin", Buffer.from("replace"))).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect((await stat(join(root, "legacy.bin"))).size).toBe(content.byteLength);
    expect(await uploadWorkspaceFile(root, "new.bin", content)).toMatchObject({ version: expect.any(String) });
    expect((await stat(join(root, "new.bin"))).size).toBe(content.byteLength);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 旧原语允许归一化后仍在根内的路径和合法 POSIX 文件名，新编辑路径继续采用严格词法校验。
test("exclusive upload preserves in-root path handling without weakening the new interface", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-compat-path-"));
  try {
    for (const path of ["nested/../legacy.txt", "notes/tab\tname.txt", "C:\\notes.txt"]) {
      expect(await uploadWorkspaceFileExclusive(root, path, Buffer.from("original"))).toBeUndefined();
      expect(await readFile(join(root, path), "utf8")).toBe("original");
      await expect(uploadWorkspaceFile(root, path, Buffer.from("new"))).rejects.toMatchObject({ code: "EINVAL" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 兼容旧调用方式不放开越界或空字节路径，调用方回调失败也必须原样传播且不创建文件。
test("exclusive upload retains path confinement and the before-open failure contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-compat-failure-"));
  try {
    for (const path of ["", ".", "../outside.txt", join(root, "absolute.txt"), "null\0.txt"])
      await expect(uploadWorkspaceFileExclusive(root, path, new Uint8Array())).rejects.toThrow("Invalid upload path");
    const failure = new Error("Caller rejected upload");
    await expect(
      uploadWorkspaceFileExclusive(root, "sub/file.txt", new Uint8Array(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await Bun.file(join(root, "sub/file.txt")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
