import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelFileOp, handleFileOp, setUploadBeforeWriteHookForTest } from "../client/file-operations";
import { initRegistry, registerWorkspace } from "../client/workspace-registry";

// 文件通道断连或请求取消必须阻止已暂存的覆盖执行 rename，不能在错误返回后迟到落盘。
test("cancelled remote overwrite never commits its staged bytes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cancel-upload-"));
  let release = () => {};
  let entered = () => {};
  const staged = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await initRegistry(workspace);
    await registerWorkspace("cancel-environment", workspace);
    await writeFile(join(workspace, "file.bin"), "original");
    setUploadBeforeWriteHookForTest(async () => {
      entered();
      await gate;
    });
    const pending = handleFileOp({
      type: "file_op",
      request_id: "cancel-overwrite",
      operation: "upload",
      params: {
        environmentId: "cancel-environment",
        overwrite: true,
        files: [
          {
            name: "file.bin",
            content: Buffer.from([0, 255, 1]).toString("base64"),
            expectedVersion: createHash("sha256").update("original").digest("hex"),
          },
        ],
      },
    });
    await staged;
    cancelFileOp("cancel-overwrite");
    release();
    expect(await pending).toMatchObject({ status: "error", error_code: "operation_timeout", status_code: 503 });
    expect(await readFile(join(workspace, "file.bin"), "utf8")).toBe("original");
  } finally {
    release();
    setUploadBeforeWriteHookForTest();
    await rm(workspace, { recursive: true, force: true });
  }
});
