import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

// @ts-expect-error Bun query import 会加载独立的真实仓储实例，同时 ../db 仍由 preload stubDb Proxy 隔离。
const { resourcePermissionRepo } = await import("../repositories/resource-permission?round64");

const existingGrant = {
  id: "grant-existing",
  organizationId: "org-owner",
  resourceType: "skill",
  resourceId: "skill-1",
  principalType: "organization",
  principalId: "org-reader",
  action: "read",
  createdBy: "user-owner",
};

function queryResult(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), { limit: async () => rows });
}

function installDb(options: { selectRows?: unknown[][]; createdRows?: unknown[]; deletedRows?: unknown[] } = {}) {
  const selectRows = [...(options.selectRows ?? [])];
  const calls = { select: 0, insert: 0, delete: 0, insertValues: [] as unknown[] };

  stubDb({
    select: () => {
      calls.select += 1;
      return {
        from: () => ({
          where: () => {
            const result = queryResult(selectRows.shift() ?? []);
            return Object.assign(result, { groupBy: () => result });
          },
        }),
      };
    },
    insert: () => {
      calls.insert += 1;
      return {
        values: (value: unknown) => {
          calls.insertValues.push(value);
          return { returning: async () => options.createdRows ?? [] };
        },
      };
    },
    delete: () => {
      calls.delete += 1;
      return { where: () => ({ returning: async () => options.deletedRows ?? [] }) };
    },
  });

  return calls;
}

const organizationGrant = {
  organizationId: "org-owner",
  resourceType: "skill" as const,
  resourceId: "skill-1",
  principalType: "organization" as const,
  principalId: "org-reader",
  action: "read" as const,
  createdBy: "user-owner",
};

describe("round64 resource-permission repository", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 按组织、类型和资源读取时返回数据库的授权记录。
  test("listByResource 返回授权记录", async () => {
    const calls = installDb({ selectRows: [[existingGrant]] });
    await expect(resourcePermissionRepo.listByResource("org-owner", "skill", "skill-1")).resolves.toEqual([
      existingGrant,
    ]);
    expect(calls.select).toBe(1);
  });

  // 无匹配资源时读取结果为空数组。
  test("listByResource 无匹配记录返回空数组", async () => {
    installDb({ selectRows: [[]] });
    await expect(resourcePermissionRepo.listByResource("org-owner", "provider", "provider-1")).resolves.toEqual([]);
  });

  // 相同组织、主体和动作已存在时复用已有授权。
  test("createGrant 复用已有组织主体授权", async () => {
    const calls = installDb({ selectRows: [[existingGrant]] });
    await expect(resourcePermissionRepo.createGrant(organizationGrant)).resolves.toEqual(existingGrant);
    expect(calls.insert).toBe(0);
  });

  // 公开主体的空 principalId 也参与幂等查询。
  test("createGrant 复用已有公开授权", async () => {
    const publicGrant = { ...existingGrant, principalType: "all", principalId: null };
    const calls = installDb({ selectRows: [[publicGrant]] });
    await expect(
      resourcePermissionRepo.createGrant({ ...organizationGrant, principalType: "all", principalId: null }),
    ).resolves.toEqual(publicGrant);
    expect(calls.insert).toBe(0);
  });

  // 不存在相同授权时创建一条新记录。
  test("createGrant 在不存在时插入记录", async () => {
    const created = { ...existingGrant, id: "grant-created" };
    const calls = installDb({ selectRows: [[]], createdRows: [created] });
    await expect(resourcePermissionRepo.createGrant(organizationGrant)).resolves.toEqual(created);
    expect(calls.insert).toBe(1);
  });

  // 创建记录完整传递所属组织。
  test("createGrant 写入所属组织", async () => {
    const calls = installDb({ selectRows: [[]], createdRows: [existingGrant] });
    await resourcePermissionRepo.createGrant(organizationGrant);
    expect(calls.insertValues[0]).toMatchObject({ organizationId: "org-owner" });
  });

  // 创建记录完整传递资源类型。
  test("createGrant 写入资源类型", async () => {
    const calls = installDb({ selectRows: [[]], createdRows: [existingGrant] });
    await resourcePermissionRepo.createGrant(organizationGrant);
    expect(calls.insertValues[0]).toMatchObject({ resourceType: "skill" });
  });

  // 创建记录完整传递资源标识。
  test("createGrant 写入资源标识", async () => {
    const calls = installDb({ selectRows: [[]], createdRows: [existingGrant] });
    await resourcePermissionRepo.createGrant(organizationGrant);
    expect(calls.insertValues[0]).toMatchObject({ resourceId: "skill-1" });
  });

  // 创建记录完整传递组织主体。
  test("createGrant 写入组织主体", async () => {
    const calls = installDb({ selectRows: [[]], createdRows: [existingGrant] });
    await resourcePermissionRepo.createGrant(organizationGrant);
    expect(calls.insertValues[0]).toMatchObject({ principalType: "organization", principalId: "org-reader" });
  });

  // 创建记录完整传递创建者。
  test("createGrant 写入创建者", async () => {
    const calls = installDb({ selectRows: [[]], createdRows: [existingGrant] });
    await resourcePermissionRepo.createGrant(organizationGrant);
    expect(calls.insertValues[0]).toMatchObject({ createdBy: "user-owner", action: "read" });
  });

  // 删除到匹配授权时报告成功。
  test("deleteGrant 删除匹配授权返回 true", async () => {
    const calls = installDb({ deletedRows: [{ id: "grant-existing" }] });
    await expect(resourcePermissionRepo.deleteGrant(organizationGrant)).resolves.toBeTrue();
    expect(calls.delete).toBe(1);
  });

  // 删除不到匹配授权时报告失败。
  test("deleteGrant 无匹配授权返回 false", async () => {
    installDb({ deletedRows: [] });
    await expect(resourcePermissionRepo.deleteGrant(organizationGrant)).resolves.toBeFalse();
  });

  // 所有类型的自有资源都将聚合计数转换为数字。
  test("listOwnedByOrganization 转换授权计数", async () => {
    installDb({
      selectRows: [
        [
          {
            organizationId: "org-owner",
            resourceType: "skill",
            resourceId: "skill-1",
            grantCount: "2",
            hasPublicRead: false,
          },
        ],
      ],
    });
    await expect(resourcePermissionRepo.listOwnedByOrganization("org-owner")).resolves.toMatchObject([
      { grantCount: 2 },
    ]);
  });

  // 自有资源保留所属组织。
  test("listOwnedByOrganization 保留所属组织", async () => {
    installDb({
      selectRows: [
        [
          {
            organizationId: "org-owner",
            resourceType: "provider",
            resourceId: "provider-1",
            grantCount: 1,
            hasPublicRead: false,
          },
        ],
      ],
    });
    await expect(resourcePermissionRepo.listOwnedByOrganization("org-owner")).resolves.toMatchObject([
      { organizationId: "org-owner" },
    ]);
  });

  // 自有资源保留资源类型和资源标识。
  test("listOwnedByOrganization 保留资源身份", async () => {
    installDb({
      selectRows: [
        [
          {
            organizationId: "org-owner",
            resourceType: "mcp_server",
            resourceId: "mcp-1",
            grantCount: 1,
            hasPublicRead: false,
          },
        ],
      ],
    });
    await expect(resourcePermissionRepo.listOwnedByOrganization("org-owner", "mcp_server")).resolves.toMatchObject([
      { resourceType: "mcp_server", resourceId: "mcp-1" },
    ]);
  });

  // 聚合到公开主体时自有资源标记为公开可读。
  test("listOwnedByOrganization 标记公开可读", async () => {
    installDb({
      selectRows: [
        [
          {
            organizationId: "org-owner",
            resourceType: "skill",
            resourceId: "skill-public",
            grantCount: 1,
            hasPublicRead: 1,
          },
        ],
      ],
    });
    await expect(resourcePermissionRepo.listOwnedByOrganization("org-owner")).resolves.toMatchObject([
      { hasPublicRead: true },
    ]);
  });

  // 非公开聚合值不会误标记为公开可读。
  test("listOwnedByOrganization 保持非公开状态", async () => {
    installDb({
      selectRows: [
        [
          {
            organizationId: "org-owner",
            resourceType: "skill",
            resourceId: "skill-private",
            grantCount: 1,
            hasPublicRead: 0,
          },
        ],
      ],
    });
    await expect(resourcePermissionRepo.listOwnedByOrganization("org-owner")).resolves.toMatchObject([
      { hasPublicRead: false },
    ]);
  });

  // 指定类型没有自有资源时返回空数组。
  test("listOwnedByOrganization 指定类型无结果返回空数组", async () => {
    installDb({ selectRows: [[]] });
    await expect(resourcePermissionRepo.listOwnedByOrganization("org-owner", "agent_config")).resolves.toEqual([]);
  });

  // 可访问列表保留资源的来源组织。
  test("listAccessibleForPrincipal 保留来源组织", async () => {
    installDb({
      selectRows: [
        [{ organizationId: "org-source", resourceType: "skill", resourceId: "skill-shared", hasPublicRead: false }],
      ],
    });
    await expect(resourcePermissionRepo.listAccessibleForPrincipal("org-reader", "skill")).resolves.toMatchObject([
      { organizationId: "org-source" },
    ]);
  });

  // 组织主体可访问的资源保留资源身份。
  test("listAccessibleForPrincipal 保留组织授权资源身份", async () => {
    installDb({
      selectRows: [
        [
          {
            organizationId: "org-source",
            resourceType: "provider",
            resourceId: "provider-shared",
            hasPublicRead: false,
          },
        ],
      ],
    });
    await expect(resourcePermissionRepo.listAccessibleForPrincipal("org-reader", "provider")).resolves.toMatchObject([
      { resourceType: "provider", resourceId: "provider-shared" },
    ]);
  });

  // 公开主体可访问的资源标记为公开可读。
  test("listAccessibleForPrincipal 标记公开资源", async () => {
    installDb({
      selectRows: [
        [{ organizationId: "org-source", resourceType: "skill", resourceId: "skill-public", hasPublicRead: true }],
      ],
    });
    await expect(resourcePermissionRepo.listAccessibleForPrincipal("org-reader", "skill")).resolves.toMatchObject([
      { hasPublicRead: true },
    ]);
  });

  // 没有公开或组织主体授权时可访问列表为空。
  test("listAccessibleForPrincipal 无授权返回空数组", async () => {
    installDb({ selectRows: [[]] });
    await expect(resourcePermissionRepo.listAccessibleForPrincipal("org-reader", "skill")).resolves.toEqual([]);
  });

  // 存在组织主体读取授权时允许读取外部资源。
  test("canReadExternalResource 组织主体授权返回 true", async () => {
    installDb({ selectRows: [[{ id: "grant-org" }]] });
    await expect(
      resourcePermissionRepo.canReadExternalResource("org-owner", "skill", "skill-1", "org-reader"),
    ).resolves.toBeTrue();
  });

  // 存在公开主体读取授权时允许读取外部资源。
  test("canReadExternalResource 公开主体授权返回 true", async () => {
    installDb({ selectRows: [[{ id: "grant-public" }]] });
    await expect(
      resourcePermissionRepo.canReadExternalResource("org-owner", "provider", "provider-1", "org-reader"),
    ).resolves.toBeTrue();
  });

  // 不存在组织或公开读取授权时拒绝读取外部资源。
  test("canReadExternalResource 无授权返回 false", async () => {
    installDb({ selectRows: [[]] });
    await expect(
      resourcePermissionRepo.canReadExternalResource("org-owner", "skill", "skill-private", "org-reader"),
    ).resolves.toBeFalse();
  });
});
