import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const mcpRoute = (await import("../routes/web/config/mcp")).default;

function setAuth() {
  setTestAuth({
    user: { id: "test-user", email: "test@test.com", name: "Test" },
    authContext: {
      organizationId: "org_current",
      userId: "test-user",
      role: "owner",
    },
  });
  setTestOrgContext({
    organizationId: "org_current",
    userId: "test-user",
    role: "owner",
  });
}

function req(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return mcpRoute.handle(new Request(`http://localhost/config/${path}`, opts));
}

describe("MCP route resource access", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuth();
  });

  // list 返回 resourceAccess，并使用源 organization 统计工具数量
  test("list 返回来源字段", async () => {
    stubConfigPg({
      listMcpServers: async () => [
        {
          id: "mcp_external",
          userId: "user_source",
          organizationId: "org_source",
          name: "shared",
          type: "remote",
          config: { type: "remote", url: "https://external.example.com" },
          enabled: true,
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          resourceAccess: {
            ownership: "external",
            sourceOrganizationId: "org_source",
            sourceOrganizationName: "Source Team",
            resourceUid: "mcp_external",
            resourceKey: "org_source/mcp_external",
            manageable: false,
            writable: false,
          },
        },
      ],
    });
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => [{ count: 2 }],
        }),
      }),
    });

    const res = await req("GET", "mcp");
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.servers[0]).toMatchObject({
      id: "mcp_external",
      name: "shared",
      toolsCount: 2,
    });
    expect(json.data.servers[0].resourceAccess).toMatchObject({
      ownership: "external",
      sourceOrganizationId: "org_source",
    });
  });

  // get 支持 resourceKey 读取外部 MCP
  test("get 支持 resourceKey", async () => {
    stubConfigPg({
      getMcpServerByResourceKey: async (_ctx, key) => ({
        id: "mcp_external",
        userId: "user_source",
        organizationId: "org_source",
        name: "shared",
        type: "remote",
        config: { type: "remote", url: `https://example.com/${key}` },
        enabled: true,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        resourceAccess: {
          ownership: "external",
          sourceOrganizationId: "org_source",
          sourceOrganizationName: "Source Team",
          resourceUid: "mcp_external",
          resourceKey: "org_source/mcp_external",
          manageable: false,
          writable: false,
        },
      }),
      getMcpServer: async () => null,
    });

    const res = await req("GET", "mcp/org_source%2Fmcp_external");
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.resourceAccess.resourceKey).toBe("org_source/mcp_external");
    expect(json.data.config.url).toBe("https://example.com/org_source/mcp_external");
  });

  // 外部 MCP write 动作返回 403（list_tools 已允许外部只读访问）
  test("外部 MCP 写动作返回 403", async () => {
    stubConfigPg({
      assertMcpServerInternalWritable: async () => {
        throw new AppError("External resource is read-only", "FORBIDDEN", 403);
      },
    });

    const actionMethods: Record<string, [string, string]> = {
      delete: ["DELETE", "mcp/shared"],
      enable: ["POST", "mcp/shared/enable"],
      disable: ["POST", "mcp/shared/disable"],
      inspect: ["POST", "mcp/shared/inspect"],
    };
    for (const [action, [method, urlPath]] of Object.entries(actionMethods)) {
      const res = await req(method, urlPath);
      const json = await res.json();
      expect(res.status).toBe(403);
      expect(json.error.code).toBe("FORBIDDEN");
    }
  });

  // update 携带 publicReadable 时透传 options，且不污染 config JSON
  test("update 透传 publicReadable 且不写入 config", async () => {
    let captured: unknown[] = [];
    stubConfigPg({
      getMcpServer: async () => ({
        id: "mcp_internal",
        userId: "test-user",
        organizationId: "org_current",
        name: "shared",
        type: "remote",
        config: { type: "remote", url: "https://old.example.com" },
        enabled: true,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
        resourceAccess: {
          ownership: "internal",
          sourceOrganizationId: "org_current",
          sourceOrganizationName: "Current Team",
          resourceUid: "mcp_internal",
          resourceKey: "org_current/mcp_internal",
          manageable: true,
          writable: true,
          publicReadable: false,
        },
      }),
      updateMcpServer: async (...args) => {
        captured = args;
        return true;
      },
    });

    const res = await req("PUT", "mcp/shared", {
      type: "remote",
      url: "https://new.example.com",
      publicReadable: true,
    });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(captured[1]).toBe("shared");
    expect(captured[2]).toEqual({ type: "remote", url: "https://new.example.com" });
    expect(captured[3]).toEqual({ publicReadable: true });
  });
});
