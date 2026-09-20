import { afterEach, describe, expect, test } from "bun:test";
import {
  createApiSandboxServerRoutes,
  setSandboxServerAdminServiceForTests,
} from "../server/routes/api/sandbox-server";
import { createStubSystemApiGuardPlugin } from "./guard-stubs";

// 守卫替身按插件名去重，同一文件内共用一个实例，避免 Elysia 静默丢弃后构造的那一份。
const apiSandboxServerRoutes = createApiSandboxServerRoutes({
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(),
});

function request(path: string, init?: RequestInit) {
  return apiSandboxServerRoutes.handle(new Request(`http://localhost${path}`, init));
}

describe("API Sandbox Server routes", () => {
  afterEach(() => {
    setSandboxServerAdminServiceForTests(null);
  });

  // 远程沙盒列表只返回 Server 数据，不应混入主服务业务实例字段。
  test("returns remote sandbox list", async () => {
    setSandboxServerAdminServiceForTests({
      listSandboxes: async () => ({
        items: [{ id: "sandbox-a", status: { state: "Running" }, createdAt: "2026-08-22T00:00:00Z" }],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNextPage: false },
      }),
      getSandbox: async () => ({ id: "sandbox-a", status: { state: "Running" }, createdAt: "2026-08-22T00:00:00Z" }),
      getDiagnostics: async () => "diagnostics",
      executeCommandStream: async () =>
        new Response('data: {"type":"execution_complete"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const response = await request("/api/system/sandbox-server/servers/server-a/sandboxes?state=Running");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: "sandbox-a" }] });
  });

  // 命令执行必须保留 SSE Content-Type 和事件 body，主服务不能把它转换成 JSON。
  test("transparently forwards command SSE", async () => {
    setSandboxServerAdminServiceForTests({
      listSandboxes: async () => ({
        items: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasNextPage: false },
      }),
      getSandbox: async () => ({ id: "sandbox-a", status: { state: "Running" }, createdAt: "2026-08-22T00:00:00Z" }),
      getDiagnostics: async () => "diagnostics",
      executeCommandStream: async () =>
        new Response('data: {"type":"execution_complete"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const response = await request("/api/system/sandbox-server/servers/server-a/sandboxes/sandbox-a/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "ls -al" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("execution_complete");
  });
});
