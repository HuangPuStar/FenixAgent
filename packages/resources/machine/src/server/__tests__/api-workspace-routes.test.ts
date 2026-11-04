import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubDb } from "@fenix/platform-sdk/testing";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "../../__tests__/guard-stubs";
import { createApiWorkspaceRoutes } from "../routes/api/workspaces";
import { setApiWorkspaceDeps } from "../services/api-workspace";
import { setLocalUploadBeforeWriteHookForTest } from "../services/file-backends";
import {
  initializeMachineModuleConfig,
  lockMachineWorkspaceRoot,
  stubFileWsTransport,
  stubMachineConfig,
  stubMachineEnvironmentRecord,
  unlockMachineWorkspaceRoot,
} from "../testing";

// 路由实例文件级构造一次：会话守卫替身按请求期读取当前会话（setTestAuth 即时生效）
const apiWorkspaceRoute = createApiWorkspaceRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

function request(path: string, init?: RequestInit) {
  return apiWorkspaceRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Workspace Routes", () => {
  let workspaceRoot: string;
  beforeEach(async () => {
    // 环境归属校验自本批起在门面内完成（授权止于 Facade）：先按生产读取路径装配模块配置，
    // 再声明环境记录替身，最后注入会话——守卫替身会被 initializeMachineModuleConfig 的复位清空。
    initializeMachineModuleConfig();
    stubMachineEnvironmentRecord({ id: "env-1", organizationId: "org-1", userId: "user-1" });
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    workspaceRoot = mkdtempSync(join(tmpdir(), "api-v1-upload-"));
    await lockMachineWorkspaceRoot(workspaceRoot);
    setApiWorkspaceDeps(null);
  });

  afterEach(async () => {
    setApiWorkspaceDeps(null);
    setLocalUploadBeforeWriteHookForTest();
    resetTestAuth();
    unlockMachineWorkspaceRoot();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // workspace 文件上传接口应将文件写入 environment 的 user 工作区，并返回标准路径。
  test("POST /api/v1/environments/:environmentId/workspace/files uploads files into user workspace", async () => {
    const workspaceDir = join(workspaceRoot, "org-1", "user-1", "env-1");
    const docsDir = join(workspaceDir, "user", "docs");

    const formData = new FormData();
    formData.append("path", "user/docs");
    formData.append("files", new File(["hello runtime"], "demo.txt", { type: "text/plain" }));

    const res = await request("/api/v1/environments/env-1/workspace/files", {
      method: "POST",
      body: formData,
    });
    const envelope = await res.json();
    expect(envelope.success).toBe(true);
    const json = envelope.data;

    expect(res.status).toBe(200);
    expect(json.environmentId).toBe("env-1");
    expect(json.files).toEqual([
      {
        name: "demo.txt",
        path: "user/docs/demo.txt",
        size: 13,
      },
    ]);
    expect(readFileSync(join(docsDir, "demo.txt"), "utf-8")).toBe("hello runtime");

    await rm(workspaceDir, { recursive: true, force: true });
  });

  // 省略目录保留 user 默认值，显式根目录和普通相对目录均写入当前认证环境。
  test.each([
    { path: undefined, expected: "user/demo.txt" },
    { path: "", expected: "demo.txt" },
    { path: ".", expected: "demo.txt" },
    { path: "./", expected: "demo.txt" },
    { path: "docs/nested", expected: "docs/nested/demo.txt" },
  ])("上传目录 $path 返回并写入 $expected", async ({ path, expected }) => {
    const form = new FormData();
    if (path !== undefined) form.set("path", path);
    form.append("files", new File(["hello"], "demo.txt"));
    const res = await request("/api/v1/environments/env-1/workspace/files", { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).data.files).toEqual([{ name: "demo.txt", path: expected, size: 5 }]);
    const duplicate = new FormData();
    if (path !== undefined) duplicate.set("path", path);
    duplicate.append("files", new File(["replacement"], "demo.txt"));
    const conflict = await request("/api/v1/environments/env-1/workspace/files", { method: "POST", body: duplicate });
    expect(conflict.status).toBe(409);
    expect(readFileSync(join(workspaceRoot, "org-1", "user-1", "env-1", expected), "utf8")).toBe("hello");
  });

  // 扩大可选目录不应放行软链接逃逸，外部目录中的文件必须保持未写入。
  test("拒绝从非 user 目录经软链接上传到工作区外", async () => {
    const workspace = join(workspaceRoot, "org-1", "user-1", "env-1");
    const outside = join(workspaceRoot, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(workspace, "linked"));
    const form = new FormData();
    form.set("path", "linked/nested");
    form.append("files", new File(["escape"], "demo.txt"));
    const res = await request("/api/v1/environments/env-1/workspace/files", { method: "POST", body: form });
    expect([400, 404]).toContain(res.status);
    expect(existsSync(join(outside, "nested", "demo.txt"))).toBe(false);
  });

  // 根目录上传同样经过安全写入，校验后替换中间目录不能把文件写出工作区。
  test("根目录上传拒绝写入前的软链接目录替换", async () => {
    const workspace = join(workspaceRoot, "org-1", "user-1", "env-1");
    const outside = join(workspaceRoot, "outside");
    await mkdir(outside);
    setLocalUploadBeforeWriteHookForTest(async () => {
      await rename(join(workspace, "nested"), join(workspace, "validated-nested"));
      await symlink(outside, join(workspace, "nested"));
    });
    const form = new FormData();
    form.set("path", ".");
    form.set("relativePaths", JSON.stringify(["nested/demo.txt"]));
    form.append("files", new File(["escape"], "demo.txt"));
    const res = await request("/api/v1/environments/env-1/workspace/files", { method: "POST", body: form });
    expect([400, 404]).toContain(res.status);
    expect(existsSync(join(outside, "demo.txt"))).toBe(false);
  });

  // 远程分支必须把 user/ 前缀原样下发给机器端，否则文件落在 workspace 根而响应仍声称在 user/。
  test("POST /api/v1/environments/:environmentId/workspace/files keeps user/ prefix for remote uploads", async () => {
    const dirs: string[] = [];
    stubMachineConfig({ defaultMachineId: "machine-1" });
    stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "machine-1" }] }) }) }) });
    stubFileWsTransport({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async (_machineId, operation, params = {}) => {
        expect(operation).toBe("upload");
        const dir = String(params.dir);
        dirs.push(dir);
        return {
          status: "ok",
          data: { files: [{ name: "demo.txt", path: dir ? `${dir}/demo.txt` : "demo.txt", size: 5 }] },
        };
      },
    });

    const explicitForm = new FormData();
    explicitForm.append("path", "user/docs");
    explicitForm.append("files", new File(["hello"], "demo.txt", { type: "text/plain" }));
    const explicitRes = await request("/api/v1/environments/env-1/workspace/files", {
      method: "POST",
      body: explicitForm,
    });
    const explicitJson = await explicitRes.json();

    expect(explicitRes.status).toBe(200);
    expect(explicitJson.data.files).toEqual([{ name: "demo.txt", path: "user/docs/demo.txt", size: 5 }]);

    const defaultForm = new FormData();
    defaultForm.append("files", new File(["hello"], "demo.txt", { type: "text/plain" }));
    const defaultRes = await request("/api/v1/environments/env-1/workspace/files", {
      method: "POST",
      body: defaultForm,
    });
    const defaultJson = await defaultRes.json();

    expect(defaultRes.status).toBe(200);
    expect(defaultJson.data.files[0]?.path).toBe("user/demo.txt");
    for (const path of ["", ".", "docs/nested"]) {
      const form = new FormData();
      form.set("path", path);
      form.append("files", new File(["hello"], "demo.txt"));
      const res = await request("/api/v1/environments/env-1/workspace/files", { method: "POST", body: form });
      expect(res.status).toBe(200);
      expect((await res.json()).data.files[0].path).toBe(path === "docs/nested" ? "docs/nested/demo.txt" : "demo.txt");
    }
    expect(dirs).toEqual(["user/docs", "user", "", "", "docs/nested"]);
  });

  // 上传目录中的 .. 段必须在派发机器前拒绝，否则会被解析到 user/ 之外并先写盘后报错。
  test("POST /api/v1/environments/:environmentId/workspace/files rejects '..' segments in upload dir", async () => {
    let remoteCalled = false;
    setApiWorkspaceDeps({
      createAgentFileService: () => {
        remoteCalled = true;
        throw new Error("must not dispatch invalid paths");
      },
    });

    for (const path of [
      "user/..",
      "user/../secret",
      "../escape",
      "docs/../secret",
      "docs\\..\\secret",
      "/tmp",
      "C:\\temp",
      "\\\\server\\share",
      "docs\u0000nested",
      "docs\n",
      "\t",
    ]) {
      const formData = new FormData();
      formData.append("path", path);
      formData.append("files", new File(["secret"], "demo.txt", { type: "text/plain" }));
      const res = await request("/api/v1/environments/env-1/workspace/files", {
        method: "POST",
        body: formData,
      });
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    }
    expect(remoteCalled).toBe(false);
  });

  // workspace 上传必须在调用本地或远程写入前拒绝目录穿越路径。
  test("POST /api/v1/environments/:environmentId/workspace/files rejects traversal paths", async () => {
    let backendCalled = false;
    setApiWorkspaceDeps({
      createAgentFileService: () => {
        backendCalled = true;
        throw new Error("must not open backend");
      },
    });

    const formData = new FormData();
    formData.append("files", new File(["secret"], "demo.txt", { type: "text/plain" }));
    formData.append("relativePaths", JSON.stringify(["../../escape.txt"]));

    const res = await request("/api/v1/environments/env-1/workspace/files", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(backendCalled).toBe(false);
  });
});
