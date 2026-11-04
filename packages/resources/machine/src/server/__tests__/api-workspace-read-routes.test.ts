import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { stubDb } from "@fenix/platform-sdk/testing";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "../../__tests__/guard-stubs";
import { createApiWorkspaceRoutes } from "../routes/api/workspaces";
import { createAgentFileService } from "../services/agent-file-service";
import { setApiWorkspaceDeps } from "../services/api-workspace";
import {
  initializeMachineModuleConfig,
  lockMachineWorkspaceRoot,
  stubFileWsTransport,
  stubMachineConfig,
  stubMachineEnvironmentRecord,
  unlockMachineWorkspaceRoot,
} from "../testing";
import { BusyError } from "../transport/file-ws-requests";

const app = createApiWorkspaceRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

/** 通过真实路由验证工作区读取与归属边界。 */
function download(path: string) {
  return app.handle(
    new Request(`http://localhost/api/v1/environments/env-1/workspace/files/download?path=${encodeURIComponent(path)}`),
  );
}

describe("外部工作区文件读取", () => {
  let root: string;
  let workspace: string;
  beforeEach(async () => {
    initializeMachineModuleConfig();
    setApiWorkspaceDeps(null);
    stubMachineEnvironmentRecord({ id: "env-1", organizationId: "org-1", userId: "user-1" });
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "member" },
    });
    root = await mkdtemp(join(tmpdir(), "api-workspace-read-"));
    workspace = join(root, "org-1", "user-1", "env-1");
    await lockMachineWorkspaceRoot(root);
    await mkdir(join(workspace, "user/docs"), { recursive: true });
  });
  afterEach(async () => {
    setApiWorkspaceDeps(null);
    resetTestAuth();
    unlockMachineWorkspaceRoot();
    await rm(root, { recursive: true, force: true });
  });

  // 文本和二进制都作为原始附件返回，中文与特殊文件名不得污染响应头。
  test.each(["报告.txt", 'quote";.bin'])("下载 %s 保留原始字节和安全附件名", async (name) => {
    const bytes = new Uint8Array([0, 128, 255, 10]);
    await writeFile(join(workspace, "user/docs", name), bytes);
    const response = await download(`user/docs/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  // 非法路径在本地和远程派发之前拒绝，目录不应被当作单文件下载。
  test.each(["../escape", "/etc/passwd", "C:\\secret", "user\n", "."])("拒绝下载路径 %j", async (path) => {
    const response = await download(path);
    expect(response.status).toBe(400);
    expect((await response.json()).success).toBe(false);
  });

  // 空文件也应正常完成下载，不能等待一个永远不会到来的数据块。
  test("空文件返回空附件，缺少文件路径返回参数错误", async () => {
    await writeFile(join(workspace, "empty.txt"), "");
    const response = await download("empty.txt");
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    const missing = await app.handle(
      new Request("http://localhost/api/v1/environments/env-1/workspace/files/download"),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).success).toBe(false);
  });

  // 不存在的文件、越界软链接和不可见环境不能读取内容。
  test("拒绝缺失文件、软链接逃逸和其他用户的工作区", async () => {
    expect((await download("missing.txt")).status).toBe(404);
    await writeFile(join(root, "outside.txt"), "outside");
    await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
    expect((await download("link.txt")).status).toBe(404);
    await writeFile(join(workspace, "private.txt"), "private");
    for (const authContext of [
      { organizationId: "org-1", userId: "other-user", role: "owner" as const },
      { organizationId: "other-org", userId: "user-1", role: "owner" as const },
    ]) {
      setTestAuth({ user: { id: authContext.userId, email: "other@test.com", name: "Other" }, authContext });
      expect((await download("private.txt")).status).toBe(404);
      const tree = await app.handle(new Request("http://localhost/api/v1/environments/env-1/workspace/files"));
      expect(tree.status).toBe(404);
    }
  });

  // 文件树包含工作区相对层级，过滤内部目录，不返回服务器绝对路径。
  test("查询完整文件树保留目录层级并过滤黑名单", async () => {
    await writeFile(join(workspace, "user/docs/probe.txt"), "probe");
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".git/config"), "hidden");
    const response = await app.handle(new Request("http://localhost/api/v1/environments/env-1/workspace/files"));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.environmentId).toBe("env-1");
    expect(json.data.paths.sort()).toEqual(["user/", "user/docs/", "user/docs/probe.txt"]);
    expect(json.data.mtimes["user/docs/probe.txt"]).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toContain(workspace);
  });

  // 远程树沿用统一过滤，部分遍历失败只暴露相对路径与通用说明。
  test("远程文件树过滤内部路径并脱敏遍历错误", async () => {
    stubMachineConfig({ defaultMachineId: "machine-1" });
    stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "machine-1" }] }) }) }) });
    stubFileWsTransport({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async (_machineId, operation, params) => {
        expect(operation).toBe("tree");
        expect(params).toMatchObject({ environmentId: "env-1" });
        return {
          status: "ok",
          data: {
            paths: ["docs/", "docs/test.txt", ".git/config"],
            mtimes: { "docs/test.txt": 123, ".git/config": 456 },
            errors: [{ path: "locked", message: "EACCES /private/server/path" }],
          },
        };
      },
    });
    const response = await app.handle(new Request("http://localhost/api/v1/environments/env-1/workspace/files"));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.paths).toEqual(["docs/", "docs/test.txt"]);
    expect(json.data.mtimes).toEqual({ "docs/test.txt": 123 });
    expect(json.data.errors).toEqual([{ path: "locked", message: "Directory could not be read" }]);
    expect(JSON.stringify(json)).not.toContain("/private/server/path");
  });

  // 客户端取消下载时必须销毁底层文件流，不能留下打开的文件句柄。
  test("取消下载释放底层文件流", async () => {
    let sent = false;
    const stream = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push("chunk");
        }
      },
    });
    setApiWorkspaceDeps({
      createAgentFileService: (scope) =>
        Object.assign(createAgentFileService(scope), {
          read: async () => ({
            type: "binary" as const,
            name: "stream.bin",
            path: "stream.bin",
            size: 5,
            mimeType: "application/octet-stream",
            stream,
          }),
        }),
    });
    const response = await download("stream.bin");
    expect(response.status).toBe(200);
    await response.body!.cancel();
    expect(stream.destroyed).toBe(true);
  });

  // 打开失败必须在附件响应前返回 JSON 错误，不能先发送 200 再中断连接。
  test("文件流首次读取失败返回统一错误包装", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("EACCES /private/file"));
      },
    });
    setApiWorkspaceDeps({
      createAgentFileService: (scope) =>
        Object.assign(createAgentFileService(scope), {
          read: async () => ({
            type: "binary" as const,
            name: "denied.bin",
            path: "denied.bin",
            size: 5,
            mimeType: "application/octet-stream",
            stream,
          }),
        }),
    });
    const response = await download("denied.bin");
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FILE_SERVICE_UNAVAILABLE");
    expect(JSON.stringify(json)).not.toContain("/private/file");
    expect(stream.destroyed).toBe(true);
  });

  // 发送开始后取消在途读取必须释放流，后续磁盘错误必须终止流而不是伪造成功完成。
  test.each(["cancel", "error"])("下载已发送首块后处理 %s", async (mode) => {
    let sent = false;
    const stream = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push("chunk");
        }
      },
    });
    setApiWorkspaceDeps({
      createAgentFileService: (scope) =>
        Object.assign(createAgentFileService(scope), {
          read: async () => ({
            type: "binary" as const,
            name: "stream.bin",
            path: "stream.bin",
            size: 10,
            mimeType: "application/octet-stream",
            stream,
          }),
        }),
    });
    const response = await download("stream.bin");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("chunk");
    const pending = reader.read();
    if (mode === "cancel") {
      await reader.cancel();
      expect((await pending).done).toBe(true);
    } else {
      stream.destroy(new Error("disk failed"));
      await expect(pending).rejects.toThrow("disk failed");
    }
    expect(stream.destroyed).toBe(true);
  });

  // 远程下载走 read_binary，断连时不能回退读取同名本地文件。
  test("远程下载保留字节，断连明确失败", async () => {
    let connected = true;
    let outcome: "ok" | "large" | "busy" = "ok";
    await writeFile(join(workspace, "local.txt"), "local");
    stubMachineConfig({ defaultMachineId: "machine-1" });
    stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "machine-1" }] }) }) }) });
    stubFileWsTransport({
      isFileWsConnected: () => connected,
      sendFileOpAndWait: async (_machineId, operation, params) => {
        if (outcome === "busy") throw new BusyError("pending limit");
        if (outcome === "large")
          return { status: "error", errorCode: "payload_too_large", statusCode: 413, error: "too large" };
        expect(operation).toBe("read_binary");
        expect(params).toMatchObject({ environmentId: "env-1", path: "remote.bin" });
        return {
          status: "ok",
          data: { name: "remote.bin", path: "remote.bin", size: 3, mimeType: "application/octet-stream", data: "AID/" },
        };
      },
    });
    const response = await download("remote.bin");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
    outcome = "large";
    expect((await download("remote.bin")).status).toBe(413);
    outcome = "busy";
    const busy = await download("remote.bin");
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    connected = false;
    const failed = await download("local.txt");
    expect(failed.status).toBe(503);
    expect((await failed.json()).success).toBe(false);
    const tree = await app.handle(new Request("http://localhost/api/v1/environments/env-1/workspace/files"));
    expect(tree.status).toBe(503);
  });
});
