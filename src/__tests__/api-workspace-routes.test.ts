import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setApiWorkspaceDeps } from "../services/api-workspace";
import { setTestOrgContext } from "../services/org-context";

const apiWorkspaceRoute = (await import("../routes/api/workspaces")).default;

function request(path: string, init?: RequestInit) {
  return apiWorkspaceRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Workspace Routes", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    setApiWorkspaceDeps({
      getOwnedEnvironment: async () => {
        throw new Error("not stubbed");
      },
      getRemoteMachineId: async () => null,
      remoteUploadFiles: async () => ({ files: [] }),
      resolveWorkspacePath: async () => null,
    });
  });

  afterEach(async () => {
    setApiWorkspaceDeps(null);
    resetTestAuth();
    setTestOrgContext(null);
  });

  // workspace 文件上传接口应将文件写入 environment 的 user 工作区，并返回标准路径。
  test("POST /api/environments/:environmentId/workspace/files uploads files into user workspace", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "fenix-runtime-upload-"));
    const userDir = join(workspaceDir, "user");
    const docsDir = join(userDir, "docs");

    setApiWorkspaceDeps({
      getOwnedEnvironment: async () => ({ id: "env-1", organizationId: "org-1" }) as never,
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
});
