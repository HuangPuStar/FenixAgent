import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import { setOrganizationRepoForTesting } from "../services/resource-permission";
import { resetAllStubs, stubDb, stubResourcePermissionRepo } from "../test-utils/helpers";

const ctx: AuthContext = {
  organizationId: "org_current",
  userId: "user_owner",
  role: "owner",
};

const now = new Date("2026-06-01T00:00:00.000Z");

function mcpRow(overrides: Partial<ReturnType<typeof baseMcpRow>>) {
  return { ...baseMcpRow(), ...overrides };
}

function baseMcpRow() {
  return {
    id: "mcp_internal",
    userId: "user_owner",
    organizationId: "org_current",
    name: "shared",
    type: "remote",
    config: { type: "remote", url: "https://internal.example.com" },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

function installDb(
  selectResults: unknown[][],
  options: {
    insertId?: string;
    updateRows?: unknown[];
    deleteRows?: unknown[];
  } = {},
) {
  const calls = {
    update: 0,
    delete: 0,
  };

  stubDb({
    select: () => ({
      from: () => ({
        where: () => queryResult(selectResults.shift() ?? []),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ id: options.insertId ?? "mcp_created" }],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            calls.update += 1;
            return options.updateRows ?? [{ id: "mcp_updated" }];
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          calls.delete += 1;
          return options.deleteRows ?? [{ id: "mcp_deleted" }];
        },
      }),
    }),
  });

  return calls;
}

describe("config mcp resource access", () => {
  beforeEach(() => {
    resetAllStubs();
    setOrganizationRepoForTesting({
      listNamesByIds: async () =>
        new Map([
          ["org_current", "Current Team"],
          ["org_source", "Source Team"],
        ]),
    });
  });

  // listMcpServers 返回内部和外部同名 MCP，并通过 resourceKey 区分身份
  test("listMcpServers 返回内部和外部同名 MCP", async () => {
    const internal = mcpRow({ id: "mcp_internal", organizationId: "org_current" });
    const external = mcpRow({
      id: "mcp_external",
      organizationId: "org_source",
      userId: "user_source",
      config: { type: "remote", url: "https://external.example.com" },
    });
    installDb([[internal], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "mcp_server", resourceId: "mcp_external", hasPublicRead: true },
      ],
      listOwnedByOrganization: async () => [
        {
          organizationId: "org_current",
          resourceType: "mcp_server",
          resourceId: "mcp_internal",
          grantCount: 1,
          hasPublicRead: true,
        },
      ],
    });

    const { listMcpServers } = await import("../services/config/mcp-server");
    const rows = await listMcpServers(ctx);

    expect(rows.map((row) => row.resourceAccess.resourceKey)).toEqual([
      "org_current/mcp_internal",
      "org_source/mcp_external",
    ]);
    expect(rows[0].resourceAccess).toMatchObject({ ownership: "internal", writable: true, publicReadable: true });
    expect(rows[1].resourceAccess).toMatchObject({ ownership: "external", writable: false });
  });

  // getMcpServerByResourceKey 可读取外部授权 MCP 详情
  test("getMcpServerByResourceKey 返回外部授权 MCP", async () => {
    const external = mcpRow({
      id: "mcp_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    installDb([[external]]);
    stubResourcePermissionRepo({
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { getMcpServerByResourceKey } = await import("../services/config/mcp-server");
    const row = await getMcpServerByResourceKey(ctx, "org_source/mcp_external");

    expect(row?.id).toBe("mcp_external");
    expect(row?.resourceAccess.resourceKey).toBe("org_source/mcp_external");
    expect(row?.resourceAccess.writable).toBe(false);
  });

  // updateMcpServer 命中外部资源时抛 403，且不会执行 DB 更新
  test("updateMcpServer 拒绝更新外部 MCP", async () => {
    const external = mcpRow({
      id: "mcp_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    const calls = installDb([[], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "mcp_server", resourceId: "mcp_external", hasPublicRead: true },
      ],
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { updateMcpServer } = await import("../services/config/mcp-server");
    await expect(updateMcpServer(ctx, "shared", { type: "remote", url: "https://next.example.com" })).rejects.toThrow(
      AppError,
    );
    expect(calls.update).toBe(0);
  });

  // deleteMcpServer 命中外部资源时抛 403，且不会执行 DB 删除
  test("deleteMcpServer 拒绝删除外部 MCP", async () => {
    const external = mcpRow({
      id: "mcp_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    const calls = installDb([[], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "mcp_server", resourceId: "mcp_external", hasPublicRead: true },
      ],
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { deleteMcpServer } = await import("../services/config/mcp-server");
    await expect(deleteMcpServer(ctx, "shared")).rejects.toThrow(AppError);
    expect(calls.delete).toBe(0);
  });

  // setMcpServerEnabled 命中外部资源时抛 403，且不会执行 DB 更新
  test("setMcpServerEnabled 拒绝启停外部 MCP", async () => {
    const external = mcpRow({
      id: "mcp_external",
      organizationId: "org_source",
      userId: "user_source",
    });
    const calls = installDb([[], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "mcp_server", resourceId: "mcp_external", hasPublicRead: true },
      ],
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { setMcpServerEnabled } = await import("../services/config/mcp-server");
    await expect(setMcpServerEnabled(ctx, "shared", false)).rejects.toThrow(AppError);
    expect(calls.update).toBe(0);
  });

  // updateMcpServer publicReadable 通过权限 service 映射为公开授权
  test("updateMcpServer publicReadable 调用 setPublicRead", async () => {
    let capturedGrant: unknown;
    const internal = mcpRow({ id: "mcp_internal", organizationId: "org_current" });
    installDb([[internal]], { updateRows: [{ id: "mcp_internal" }] });
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [],
      createGrant: async (input) => {
        capturedGrant = input;
        return {
          id: "grant_1",
          ...input,
          createdAt: now,
          updatedAt: now,
        };
      },
    });

    const { updateMcpServer } = await import("../services/config/mcp-server");
    const result = await updateMcpServer(
      ctx,
      "shared",
      { type: "remote", url: "https://updated.example.com" },
      { publicReadable: true },
    );

    expect(result).toBe(true);
    expect(capturedGrant).toEqual({
      organizationId: "org_current",
      resourceType: "mcp_server",
      resourceId: "mcp_internal",
      principalType: "all",
      principalId: null,
      action: "read",
      createdBy: "user_owner",
    });
  });
});
