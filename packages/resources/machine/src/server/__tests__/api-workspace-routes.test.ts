import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "../../__tests__/guard-stubs";
import { createApiWorkspaceRoutes } from "../routes/api/workspaces";
import { setApiWorkspaceDeps } from "../services/api-workspace";
import { initializeMachineModuleConfig, stubMachineEnvironmentRecord } from "../testing";

// 路由实例文件级构造一次：会话守卫替身按请求期读取当前会话（setTestAuth 即时生效）
const apiWorkspaceRoute = createApiWorkspaceRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

function request(path: string, init?: RequestInit) {
  return apiWorkspaceRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Workspace Routes", () => {
  beforeEach(() => {
    // 环境归属校验自本批起在门面内完成（授权止于 Facade）：先按生产读取路径装配模块配置，
    // 再声明环境记录替身，最后注入会话——守卫替身会被 initializeMachineModuleConfig 的复位清空。
    initializeMachineModuleConfig();
    stubMachineEnvironmentRecord({ id: "env-1", organizationId: "org-1", userId: "user-1" });
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setApiWorkspaceDeps({
      getRemoteMachineId: async () => null,
      remoteUploadFiles: async () => ({ files: [] }),
      resolveWorkspacePath: async () => null,
    });
  });

  afterEach(async () => {
    setApiWorkspaceDeps(null);
    resetTestAuth();
  });

  // workspace 文件上传接口应将文件写入 environment 的 user 工作区，并返回标准路径。
  test("POST /api/environments/:environmentId/workspace/files uploads files into user workspace", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "fenix-runtime-upload-"));
    const userDir = join(workspaceDir, "user");
    const docsDir = join(userDir, "docs");

    setApiWorkspaceDeps({
      getRemoteMachineId: async () => null,
      resolveWorkspacePath: async () =>
        ({
          resolved: docsDir,
        }) as never,
    });

    const formData = new FormData();
    formData.append("path", "docs");
    formData.append("files", new File(["hello runtime"], "demo.txt", { type: "text/plain" }));

    const res = await request("/api/environments/env-1/workspace/files", {
      method: "POST",
      body: formData,
    });
    const json = await res.json();

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
  test("POST /api/environments/:environmentId/workspace/files keeps user/ prefix for remote uploads", async () => {
    const dirs: string[] = [];
    setApiWorkspaceDeps({
      getRemoteMachineId: async () => "machine-1",
      remoteUploadFiles: async (_machineId, _envId, dir) => {
        dirs.push(dir);
        return { files: [{ name: "demo.txt", path: `${dir}/demo.txt`, size: 5 }] };
      },
    });

    const explicitForm = new FormData();
    explicitForm.append("path", "docs");
    explicitForm.append("files", new File(["hello"], "demo.txt", { type: "text/plain" }));
    const explicitRes = await request("/api/environments/env-1/workspace/files", {
      method: "POST",
      body: explicitForm,
    });
    const explicitJson = await explicitRes.json();

    expect(explicitRes.status).toBe(200);
    expect(explicitJson.files).toEqual([{ name: "demo.txt", path: "user/docs/demo.txt", size: 5 }]);

    const defaultForm = new FormData();
    defaultForm.append("files", new File(["hello"], "demo.txt", { type: "text/plain" }));
    const defaultRes = await request("/api/environments/env-1/workspace/files", {
      method: "POST",
      body: defaultForm,
    });
    const defaultJson = await defaultRes.json();

    expect(defaultRes.status).toBe(200);
    expect(defaultJson.files[0]?.path).toBe("user/demo.txt");
    expect(dirs).toEqual(["user/docs", "user"]);
  });

  // workspace 上传必须在调用本地或远程写入前拒绝目录穿越路径。
  test("POST /api/environments/:environmentId/workspace/files rejects traversal paths", async () => {
    let remoteCalled = false;
    setApiWorkspaceDeps({
      getRemoteMachineId: async () => "machine-1",
      remoteUploadFiles: async () => {
        remoteCalled = true;
        return { files: [] };
      },
    });

    const formData = new FormData();
    formData.append("files", new File(["secret"], "demo.txt", { type: "text/plain" }));
    formData.append("relativePaths", JSON.stringify(["../../escape.txt"]));

    const res = await request("/api/environments/env-1/workspace/files", {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(400);
    expect(remoteCalled).toBe(false);
  });
});
