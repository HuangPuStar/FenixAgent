import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubDb } from "@fenix/platform-sdk/testing";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "../../__tests__/guard-stubs";
import { createApiWorkspaceRoutes } from "../routes/api/workspaces";
import { setApiWorkspaceDeps } from "../services/api-workspace";
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
        return { status: "ok", data: { files: [{ name: "demo.txt", path: `${dir}/demo.txt`, size: 5 }] } };
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
    expect(dirs).toEqual(["user/docs", "user"]);
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

    for (const path of ["user/..", "user/../secret"]) {
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
