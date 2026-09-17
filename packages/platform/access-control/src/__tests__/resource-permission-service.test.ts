import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetDeps,
  assertInternalWritable,
  canReadResource,
  configureResourcePermissionService,
  decorateResourceAccess,
  listReadableResourceRefs,
  setOrganizationRepoForTesting,
  setPublicRead,
  setResourcePermissionRepoForTesting,
} from "@fenix/access-control/server";
import type { IResourcePermissionRepo, ResourcePermissionGrantRow } from "../repositories/resource-permission";
import type { ResourcePermissionAuthContext } from "../resource-permission";

const ownerCtx: ResourcePermissionAuthContext = {
  organizationId: "org_current",
  userId: "user_owner",
  role: "owner",
};

const memberCtx: ResourcePermissionAuthContext = {
  organizationId: "org_current",
  userId: "user_member",
  role: "member",
};

const grantRow = {
  id: "grant_1",
  organizationId: "org_current",
  resourceType: "skill",
  resourceId: "skill_1",
  principalType: "all",
  principalId: null,
  action: "read",
  createdBy: "user_owner",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
} satisfies ResourcePermissionGrantRow;

function stubResourcePermissionRepo(overrides: Partial<IResourcePermissionRepo>) {
  setResourcePermissionRepoForTesting({
    listByResource: async () => [],
    createGrant: async () => grantRow,
    deleteGrant: async () => false,
    listOwnedByOrganization: async () => [],
    listAccessibleForPrincipal: async () => [],
    canReadExternalResource: async () => false,
    ...overrides,
  });
}

describe("resource-permission service", () => {
  beforeEach(() => {
    _resetDeps();
    configureResourcePermissionService({
      organizationRepo: {
        listNamesByIds: async () =>
          new Map([
            ["org_current", "Current Team"],
            ["org_source", "Source Team"],
          ]),
      },
      createError: (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode }),
    });
  });

  // owner 组织内资源可写、可管理，并带公开读取状态
  test("owner 内部资源返回 internal access", async () => {
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [
        {
          organizationId: "org_current",
          resourceType: "skill",
          resourceId: "skill_1",
          grantCount: 1,
          hasPublicRead: true,
        },
      ],
    });

    const [row] = await decorateResourceAccess(ownerCtx, "skill", [
      { id: "skill_1", organizationId: "org_current", name: "build" },
    ]);

    expect(row.resourceAccess).toEqual({
      ownership: "internal",
      sourceOrganizationId: "org_current",
      sourceOrganizationName: "Current Team",
      resourceUid: "skill_1",
      resourceKey: "org_current/skill_1",
      manageable: true,
      writable: true,
      publicReadable: true,
    });
  });

  // member 组织内资源可写，且公开开关能力与原写接口保持一致
  test("member 内部资源允许管理公开状态", async () => {
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [],
    });

    const [row] = await decorateResourceAccess(memberCtx, "skill", [{ id: "skill_1", organizationId: "org_current" }]);

    expect(row.resourceAccess.manageable).toBe(true);
    expect(row.resourceAccess.writable).toBe(true);
    expect(row.resourceAccess.publicReadable).toBe(false);
  });

  // 外部授权资源只读、不可管理，并使用 ownerOrg/resourceId 作为稳定 key
  test("外部授权资源返回 external access", async () => {
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [],
    });

    const [row] = await decorateResourceAccess(ownerCtx, "mcp_server", [
      { id: "mcp_1", organizationId: "org_source", name: "shared" },
    ]);

    expect(row.resourceAccess).toEqual({
      ownership: "external",
      sourceOrganizationId: "org_source",
      sourceOrganizationName: "Source Team",
      resourceUid: "mcp_1",
      resourceKey: "org_source/mcp_1",
      manageable: false,
      writable: false,
      publicReadable: undefined,
    });
  });

  // listReadableResourceRefs 只返回外部可读引用
  test("过滤掉当前组织自己的可读授权引用", async () => {
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_current", resourceType: "skill", resourceId: "skill_own", hasPublicRead: true },
        { organizationId: "org_source", resourceType: "skill", resourceId: "skill_ext", hasPublicRead: true },
      ],
    });

    const rows = await listReadableResourceRefs(ownerCtx, "skill");

    expect(rows).toEqual([
      { organizationId: "org_source", resourceType: "skill", resourceId: "skill_ext", hasPublicRead: true },
    ]);
  });

  // setPublicRead(true) 写入 all:read grant
  test("setPublicRead 启用时创建 all read grant", async () => {
    let captured: unknown;
    stubResourcePermissionRepo({
      createGrant: async (input) => {
        captured = input;
        return grantRow;
      },
    });

    const result = await setPublicRead(ownerCtx, "skill", "org_current", "skill_1", true);

    expect(result).toBe(grantRow);
    expect(captured).toEqual({
      organizationId: "org_current",
      resourceType: "skill",
      resourceId: "skill_1",
      principalType: "all",
      principalId: null,
      action: "read",
      createdBy: "user_owner",
    });
  });

  // setPublicRead(false) 删除 all:read grant
  test("setPublicRead 关闭时删除 all read grant", async () => {
    let captured: unknown;
    stubResourcePermissionRepo({
      deleteGrant: async (input) => {
        captured = input;
        return true;
      },
    });

    const result = await setPublicRead(ownerCtx, "skill", "org_current", "skill_1", false);

    expect(result).toBe(true);
    expect(captured).toEqual({
      organizationId: "org_current",
      resourceType: "skill",
      resourceId: "skill_1",
      principalType: "all",
      principalId: null,
      action: "read",
    });
  });

  // 外部 ownerOrganizationId 写入被拒绝为 403 授权错误
  test("assertInternalWritable 拒绝外部资源写入", () => {
    expect(() => assertInternalWritable(ownerCtx, "skill", "skill_1", "org_source")).toThrow(
      "External resource is read-only",
    );

    try {
      assertInternalWritable(ownerCtx, "skill", "skill_1", "org_source");
      throw new Error("should not reach");
    } catch (err) {
      expect((err as { code: string }).code).toBe("FORBIDDEN");
      expect((err as { statusCode: number }).statusCode).toBe(403);
    }
  });

  // canReadResource 内部资源直接允许，外部资源委托仓储判断
  test("canReadResource 区分内部和外部资源", async () => {
    let captured: unknown;
    stubResourcePermissionRepo({
      canReadExternalResource: async (...args) => {
        captured = args;
        return true;
      },
    });

    await expect(canReadResource(ownerCtx, "provider", "provider_own", "org_current")).resolves.toBe(true);
    await expect(canReadResource(ownerCtx, "provider", "provider_ext", "org_source")).resolves.toBe(true);
    expect(captured).toEqual(["org_source", "provider", "provider_ext", "org_current"]);
  });
});
