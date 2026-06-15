import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const apiMcpRoute = (await import("../routes/api/mcp")).default;

function request(path: string, init?: RequestInit) {
  return apiMcpRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API MCP Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    stubConfigPg({
      listMcpServers: async () => [],
      getMcpServer: async () => null,
      getMcpServerById: async () => null,
      getMcpServerByResourceKey: async () => null,
      createMcpServer: async () => undefined,
      updateMcpServer: async () => false,
      updateMcpServerById: async () => false,
      deleteMcpServer: async () => true,
      deleteMcpServerById: async () => true,
    });
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  // MCP 列表接口应返回稳定分页结构，即使当前没有任何 server。
  test("GET /api/mcp returns paginated list shape", async () => {
    const res = await request("/api/mcp?page=1&pageSize=20");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  // MCP 更新接口在资源不存在时应返回统一错误结构，而不是静默成功。
  test("PUT /api/mcp/:id returns message when target does not exist", async () => {
    const res = await request("/api/mcp/demo-server", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/mcp", type: "remote" }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "MCP server 'demo-server' not found",
      },
    });
  });

  // MCP 删除接口应返回被删除资源的唯一 ID，避免把 name 和 id 混用。
  test("DELETE /api/mcp/:id returns deleted id", async () => {
    const res = await request("/api/mcp/demo-server-id", {
      method: "DELETE",
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "demo-server-id",
      deleted: true,
    });
  });
});
