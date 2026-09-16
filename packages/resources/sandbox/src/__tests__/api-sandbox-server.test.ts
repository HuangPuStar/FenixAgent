import { afterEach, describe, expect, test } from "bun:test";
import apiSandboxServerRoutes, { setSandboxServerAdminServiceForTests } from "../routes/api/sandbox-server";

function request(path: string, init?: RequestInit) {
  return apiSandboxServerRoutes.handle(new Request(`http://localhost${path}`, init));
}

describe("API Sandbox Server routes", () => {
  const originalKeys = process.env.RCS_SYSTEM_API_KEYS;

  afterEach(() => {
    process.env.RCS_SYSTEM_API_KEYS = originalKeys;
    setSandboxServerAdminServiceForTests(null);
  });

  // 远程 Server 管理接口属于系统管理能力，未携带系统 key 时必须拒绝访问。
  test("requires a system API key", async () => {
    process.env.RCS_SYSTEM_API_KEYS = "sandbox-server-test-key";

    const response = await request("/api/system/sandbox-server/servers/server-a/sandboxes");

    expect(response.status).toBe(401);
  });

  // 远程沙盒列表只返回 Server 数据，不应混入主服务业务实例字段。
  test("returns remote sandbox list", async () => {
    process.env.RCS_SYSTEM_API_KEYS = "sandbox-server-test-key";
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

    const response = await request("/api/system/sandbox-server/servers/server-a/sandboxes?state=Running", {
      headers: { Authorization: "Bearer sandbox-server-test-key" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: "sandbox-a" }] });
  });

  // 命令执行必须保留 SSE Content-Type 和事件 body，主服务不能把它转换成 JSON。
  test("transparently forwards command SSE", async () => {
    process.env.RCS_SYSTEM_API_KEYS = "sandbox-server-test-key";
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
      headers: {
        Authorization: "Bearer sandbox-server-test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: "ls -al" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("execution_complete");
  });
});
