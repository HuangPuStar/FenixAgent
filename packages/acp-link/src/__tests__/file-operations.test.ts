import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFileOp } from "../client/file-operations";
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
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("handleFileOp", () => {
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
      error: "Invalid file path: ../../escape.txt escapes target directory",
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
