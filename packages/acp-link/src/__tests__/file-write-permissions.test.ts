import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFileOp } from "../client/file-operations";
import { initRegistry, registerWorkspace } from "../client/workspace-registry";

// 远程旧文本写入与覆盖上传均须保留脚本执行位，确保保存后仍能由 Agent 运行。
test.each(["write", "upload"])("remote %s preserves executable permissions", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "remote-write-mode-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await initRegistry(root);
    const environmentId = `mode-${crypto.randomUUID()}`;
    await registerWorkspace(environmentId, workspace);
    const path = join(workspace, "run.sh");
    await writeFile(path, "#!/bin/sh\nexit 9\n");
    await chmod(path, 0o755);
    const content = "#!/bin/sh\nexit 0\n";
    const params =
      operation === "write"
        ? { path: "run.sh", content }
        : { dir: "", overwrite: true, files: [{ name: "run.sh", content: Buffer.from(content).toString("base64") }] };
    expect(
      await handleFileOp({
        type: "file_op",
        request_id: `mode-${operation}`,
        operation,
        params: { environmentId, ...params },
      }),
    ).toMatchObject({ status: "ok" });
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect(await readFile(path, "utf8")).toBe(content);
    expect(Bun.spawnSync([path]).exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
