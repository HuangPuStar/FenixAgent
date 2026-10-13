import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleFileOp,
  setDirectoryRenameBeforeMoveHookForTest,
  setUploadBeforeWriteHookForTest,
  setZipBeforeSpawnHookForTest,
} from "../client/file-operations";
import { initRegistry, registerWorkspace } from "../client/workspace-registry";

interface FileOpData {
  [key: string]: unknown;
}

type FileOpMessage = Parameters<typeof handleFileOp>[0];

const temporaryDirectories: string[] = [];

function createMessage(environmentId: string, operation: string, params: FileOpData = {}): FileOpMessage {
  return {
    type: "file_op",
    request_id: `${environmentId}-${operation}`,
    operation,
    params: { environmentId, ...params },
  };
}

async function createWorkspace(): Promise<{ workspace: string; environmentId: string }> {
  const registryRoot = await mkdtemp(join(tmpdir(), "acp-link-file-registry-"));
  const workspace = await mkdtemp(join(tmpdir(), "acp-link-file-workspace-"));
  temporaryDirectories.push(registryRoot, workspace);

  const environmentId = `environment-${crypto.randomUUID()}`;
  await initRegistry(registryRoot);
  await registerWorkspace(environmentId, workspace);
  return { workspace, environmentId };
}

afterEach(async () => {
  setDirectoryRenameBeforeMoveHookForTest();
  setUploadBeforeWriteHookForTest();
  setZipBeforeSpawnHookForTest();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("handleFileOp", () => {
  // 机器端搬迁前故障只清理自己的空占位，绝不能删除源目录或其内容。
  test("远程目录搬迁失败清理自己的空占位", async () => {
    const { workspace, environmentId } = await createWorkspace();
    await mkdir(join(workspace, "source"));
    await writeFile(join(workspace, "source/item.txt"), "source");
    setDirectoryRenameBeforeMoveHookForTest(async () => {
      throw new Error("injected before-move failure");
    });
    expect(
      await handleFileOp(createMessage(environmentId, "rename", { oldPath: "source", newPath: "target" })),
    ).toMatchObject({ status: "error" });
    expect(await readFile(join(workspace, "source/item.txt"), "utf8")).toBe("source");
    await expect(readFile(join(workspace, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // 目录占位被并发写入时必须409且不能递归删除目标或丢失源目录内容。
  test("远程目录占位被填入内容后保留双方", async () => {
    const { workspace, environmentId } = await createWorkspace();
    await mkdir(join(workspace, "source"));
    await writeFile(join(workspace, "source/item.txt"), "source");
    setDirectoryRenameBeforeMoveHookForTest(async (destination) => {
      await writeFile(join(destination, "concurrent.txt"), "concurrent");
    });
    const result = await handleFileOp(createMessage(environmentId, "rename", { oldPath: "source", newPath: "target" }));
    expect(result).toMatchObject({ status: "error", error_code: "path_conflict", status_code: 409 });
    expect(await readFile(join(workspace, "source/item.txt"), "utf8")).toBe("source");
    expect(await readFile(join(workspace, "target/concurrent.txt"), "utf8")).toBe("concurrent");
  });

  // 机器端重命名不能覆盖同名文件，协议应明确返回409且源目标保持完整。
  test("远程 rename 冲突保留双方内容", async () => {
    const { workspace, environmentId } = await createWorkspace();
    await writeFile(join(workspace, "source.txt"), "source");
    await writeFile(join(workspace, "target.txt"), "target");
    const result = await handleFileOp(
      createMessage(environmentId, "rename", { oldPath: "source.txt", newPath: "target.txt" }),
    );
    expect(result).toMatchObject({ status: "error", error_code: "path_conflict", status_code: 409 });
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe("source");
    expect(await readFile(join(workspace, "target.txt"), "utf8")).toBe("target");
  });

  // 远程目录排他占用目标，已有空目录也拒绝覆盖，并允许移动到全新路径。
  test("远程目录 rename 拒绝已有目标且可移动到新目标", async () => {
    const { workspace, environmentId } = await createWorkspace();
    await mkdir(join(workspace, "source"));
    await writeFile(join(workspace, "source/item.txt"), "source");
    await mkdir(join(workspace, "target"));
    const result = await handleFileOp(createMessage(environmentId, "rename", { oldPath: "source", newPath: "target" }));
    expect(result).toMatchObject({ status: "error", error_code: "path_conflict", status_code: 409 });
    expect(await readFile(join(workspace, "source/item.txt"), "utf8")).toBe("source");
    expect(await Bun.file(join(workspace, "target/item.txt")).exists()).toBe(false);
    expect(
      await handleFileOp(createMessage(environmentId, "rename", { oldPath: "source", newPath: "new-parent/moved" })),
    ).toMatchObject({ status: "ok" });
    expect(await readFile(join(workspace, "new-parent/moved/item.txt"), "utf8")).toBe("source");
    expect(await Bun.file(join(workspace, "source/item.txt")).exists()).toBe(false);
  });

  // 远程上传同名文件使用排他创建，并发赢家之后的重传不能改变已写字节。
  test("远程并发上传只能一个成功且重复上传返回409", async () => {
    const { workspace, environmentId } = await createWorkspace();
    const upload = (content: string, requestId: string) =>
      handleFileOp({
        ...createMessage(environmentId, "upload", {
          files: [{ name: "same.txt", content: Buffer.from(content).toString("base64") }],
        }),
        request_id: requestId,
      });
    const results = await Promise.all([upload("first", "first"), upload("second", "second")]);
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.find((result) => result.status === "error")).toMatchObject({
      error_code: "path_conflict",
      status_code: 409,
    });
    const original = await readFile(join(workspace, "same.txt"), "utf8");
    expect(["first", "second"]).toContain(original);
    expect(await upload("replacement", "third")).toMatchObject({
      status: "error",
      error_code: "path_conflict",
      status_code: 409,
    });
    expect(await readFile(join(workspace, "same.txt"), "utf8")).toBe(original);
  });

  // 未注册环境不得访问文件系统，并且未知操作必须返回协议错误而非抛出异常
  test("拒绝未知 workspace 与未知操作", async () => {
    const missingWorkspace = await handleFileOp(createMessage("missing-environment", "list"));
    expect(missingWorkspace).toMatchObject({
      status: "error",
      error: "Workspace not found for environment: missing-environment",
    });

    const { environmentId } = await createWorkspace();
    const unknownOperation = await handleFileOp(createMessage(environmentId, "unsupported"));
    expect(unknownOperation).toMatchObject({ status: "error", error: "Unknown operation: unsupported" });
  });

  // 文件列表、属性与文本读取应保留相对路径、过滤内部目录，并拒绝越界路径
  test("列出并读取 workspace 文件且阻止路径穿越", async () => {
    const { workspace, environmentId } = await createWorkspace();
    await mkdir(join(workspace, "docs"));
    await mkdir(join(workspace, ".claude"));
    await writeFile(join(workspace, "docs", "note.txt"), "hello", "utf-8");
    await writeFile(join(workspace, "hidden.txt"), "hidden", "utf-8");

    const list = await handleFileOp(createMessage(environmentId, "list"));
    const listEntries = (list.data as { entries: Array<{ name: string }> }).entries;
    expect(listEntries.some((entry) => entry.name === ".claude")).toBe(false);
    expect(list).toMatchObject({
      status: "ok",
      data: {
        entries: expect.arrayContaining([
          expect.objectContaining({ name: "docs", path: "docs", type: "dir" }),
          expect.objectContaining({ name: "hidden.txt", path: "hidden.txt", type: "file", size: 6 }),
        ]),
      },
    });

    const stat = await handleFileOp(createMessage(environmentId, "stat", { path: "docs/note.txt" }));
    expect(stat).toMatchObject({ status: "ok", data: { size: 5, isDirectory: false } });

    const read = await handleFileOp(createMessage(environmentId, "read", { path: "docs/note.txt" }));
    expect(read).toMatchObject({
      status: "ok",
      data: { name: "note.txt", path: "docs/note.txt", content: "hello", size: 5, encoding: "utf-8" },
    });

    const traversal = await handleFileOp(createMessage(environmentId, "read", { path: "../outside.txt" }));
    expect(traversal).toMatchObject({ status: "error", error: "Invalid path: path traversal detected" });
  });

  test("打包 workspace 目录并拒绝越界路径", async () => {
    const { workspace, environmentId } = await createWorkspace();
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "note.txt"), "hello", "utf-8");

    const result = await handleFileOp(createMessage(environmentId, "zip", { path: "docs" }));
    expect(result.status).toBe("ok");
    const archive = Buffer.from(result.data as string, "base64");
    expect(archive.subarray(0, 2).toString()).toBe("PK");

    const traversal = await handleFileOp(createMessage(environmentId, "zip", { path: "../outside" }));
    expect(traversal).toMatchObject({ status: "error", error: "Invalid path: path traversal detected" });
  });

  test("上传保留尾随空格并拒绝 symlink 落点及 mkdir/write 竞态", async () => {
    const { workspace, environmentId } = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "acp-link-upload-outside-"));
    temporaryDirectories.push(outside);

    const spaced = await handleFileOp(
      createMessage(environmentId, "upload", {
        dir: "uploads",
        files: [
          { name: "a.txt", content: Buffer.from("plain").toString("base64") },
          { name: "a.txt ", content: Buffer.from("spaced").toString("base64") },
        ],
      }),
    );
    expect(spaced.status).toBe("ok");
    expect(await readFile(join(workspace, "uploads", "a.txt"), "utf8")).toBe("plain");
    expect(await readFile(join(workspace, "uploads", "a.txt "), "utf8")).toBe("spaced");

    await symlink(outside, join(workspace, "linked"));
    const linked = await handleFileOp(
      createMessage(environmentId, "upload", {
        dir: "linked",
        files: [{ name: "secret.txt", content: Buffer.from("secret").toString("base64") }],
      }),
    );
    expect(linked).toMatchObject({ status: "error", error_code: "unsafe_symlink" });
    expect(await Bun.file(join(outside, "secret.txt")).exists()).toBe(false);

    await mkdir(join(workspace, "race"));
    setUploadBeforeWriteHookForTest(async () => {
      await rename(join(workspace, "race"), join(workspace, "validated-race"));
      await symlink(outside, join(workspace, "race"));
    });
    const raced = await handleFileOp(
      createMessage(environmentId, "upload", {
        dir: "race",
        files: [{ name: "raced.txt", content: Buffer.from("raced").toString("base64") }],
      }),
    );
    expect(raced).toMatchObject({ status: "error", error_code: "unsafe_symlink" });
    expect(await Bun.file(join(outside, "raced.txt")).exists()).toBe(false);
  });

  // ZIP 必须拒绝顶层及归档树内 symlink，避免 zip 跟随链接读取其他租户或宿主目录。
  test("拒绝 ZIP 顶层和归档树内 symbolic link", async () => {
    const { workspace, environmentId } = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "acp-link-file-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret", "utf-8");
    await symlink(outside, join(workspace, "outside-link"));

    const topLevel = await handleFileOp(createMessage(environmentId, "zip", { path: "outside-link" }));
    expect(topLevel).toMatchObject({ status: "error", error_code: "unsafe_symlink", status_code: 503 });

    await mkdir(join(workspace, "docs"));
    await symlink(join(outside, "secret.txt"), join(workspace, "docs", "secret-link"));
    const nested = await handleFileOp(createMessage(environmentId, "zip", { path: "docs" }));
    expect(nested).toMatchObject({ status: "error", error_code: "unsafe_symlink", status_code: 503 });
  });

  // 校验后的路径层级可能被并发替换；ZIP 不得按原 archivePath 跟随新 symlink。
  test("拒绝校验后被替换为外部 symlink 的中间目录", async () => {
    const { workspace, environmentId } = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "acp-link-file-race-outside-"));
    temporaryDirectories.push(outside);
    await mkdir(join(workspace, "parent", "docs"), { recursive: true });
    await writeFile(join(workspace, "parent", "docs", "safe.txt"), "safe", "utf-8");
    await writeFile(join(outside, "secret.txt"), "secret", "utf-8");

    setZipBeforeSpawnHookForTest(async () => {
      await rename(join(workspace, "parent"), join(workspace, "validated-parent"));
      await symlink(outside, join(workspace, "parent"));
    });

    const result = await handleFileOp(createMessage(environmentId, "zip", { path: "parent/docs" }));
    expect(result).toMatchObject({ status: "error", error_code: "unsafe_symlink", status_code: 503 });
  });

  // 写入、上传、重命名、建目录和删除必须只影响 workspace 内的目标路径
  test("执行受限的写入型文件操作", async () => {
    const { workspace, environmentId } = await createWorkspace();

    const write = await handleFileOp(
      createMessage(environmentId, "write", { path: "notes/first.txt", content: "first" }),
    );
    expect(write).toMatchObject({ status: "ok", data: { name: "first.txt", path: "notes/first.txt", size: 5 } });
    expect(await readFile(join(workspace, "notes", "first.txt"), "utf-8")).toBe("first");

    const upload = await handleFileOp(
      createMessage(environmentId, "upload", {
        dir: "uploads",
        files: [
          { name: "one.txt", content: Buffer.from("one").toString("base64") },
          { name: "two.txt", relativePath: "nested/two.txt", content: Buffer.from("two").toString("base64") },
        ],
      }),
    );
    expect(upload).toMatchObject({
      status: "ok",
      data: {
        files: [
          { name: "one.txt", path: "uploads/one.txt", size: 3 },
          { name: "two.txt", path: "uploads/nested/two.txt", size: 3 },
        ],
      },
    });

    const rename = await handleFileOp(
      createMessage(environmentId, "rename", { oldPath: "notes/first.txt", newPath: "archive/renamed.txt" }),
    );
    expect(rename).toMatchObject({
      status: "ok",
      data: { oldPath: "notes/first.txt", newPath: "archive/renamed.txt" },
    });

    const mkdirResult = await handleFileOp(createMessage(environmentId, "mkdir", { path: "empty/directory" }));
    expect(mkdirResult).toMatchObject({ status: "ok", data: { path: "empty/directory" } });

    const deleted = await handleFileOp(createMessage(environmentId, "delete", { path: "archive" }));
    expect(deleted).toMatchObject({ status: "ok", data: { ok: true } });
    expect(await Bun.file(join(workspace, "archive", "renamed.txt")).exists()).toBe(false);

    const escapedUpload = await handleFileOp(
      createMessage(environmentId, "upload", {
        dir: "uploads",
        files: [{ name: "escape.txt", relativePath: "../../escape.txt", content: "" }],
      }),
    );
    expect(escapedUpload).toMatchObject({
      status: "error",
      error: "Invalid upload path: expected a non-blank relative path without '..' or control characters",
    });
  });

  // 二进制读取和文件树须编码内容、推断 MIME，并省略内部工作目录
  test("读取二进制文件并生成过滤后的文件树", async () => {
    const { workspace, environmentId } = await createWorkspace();
    await mkdir(join(workspace, "assets"));
    await mkdir(join(workspace, ".peri"));
    await writeFile(join(workspace, "assets", "image.png"), Buffer.from([0, 1, 2]));
    await writeFile(join(workspace, ".peri", "state.json"), "{}", "utf-8");

    const binary = await handleFileOp(createMessage(environmentId, "read_binary", { path: "assets/image.png" }));
    expect(binary).toMatchObject({
      status: "ok",
      data: { name: "image.png", path: "assets/image.png", data: "AAEC", size: 3, mimeType: "image/png" },
    });

    const tree = await handleFileOp(createMessage(environmentId, "tree"));
    expect(tree).toMatchObject({ status: "ok", data: { paths: ["assets/", "assets/image.png"] } });
  });
});
