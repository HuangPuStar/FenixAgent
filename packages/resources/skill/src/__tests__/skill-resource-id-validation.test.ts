import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetDeps as resetAccessControlDeps } from "@fenix/access-control/server";
import { resetAllStubs, stubDb, stubResourcePermissionRepo } from "@server/test-utils/helpers";

// @ts-expect-error 查询后缀隔离真实 config service，避免 preload 的宿主 config barrel mock 截获。
const { listSkills } = await import("../server/services/config/skill?resource-id-validation");

const ctx = { organizationId: "org-current", userId: "user-current", role: "owner" } as const;
const UPPERCASE_UUID = "123E4567-E89B-42D3-A456-426614174000";
const LOWERCASE_UUID = UPPERCASE_UUID.toLowerCase();
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** 构造 PostgreSQL 查询返回的最小 Skill 记录。 */
function skillRow(id: string, name: string) {
  return {
    id,
    userId: "user-source",
    organizationId: "org-source",
    name,
    description: null,
    metadata: {},
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    updatedAt: new Date("2026-09-17T00:00:00.000Z"),
  };
}

/** 注入 listSkills 所需的两阶段查询，并返回实际 select 次数。 */
function installSkillDb(externalRows: ReturnType<typeof skillRow>[]) {
  let selectCalls = 0;
  stubDb({
    select: () => {
      selectCalls += 1;
      const rows = selectCalls === 1 ? [] : externalRows;
      return {
        from: () => ({
          where: () => Object.assign(Promise.resolve(rows), { orderBy: async () => rows }),
        }),
      };
    },
  });
  return () => selectCalls;
}

describe("skill external resource identifiers", () => {
  beforeEach(() => {
    resetAllStubs();
    resetAccessControlDeps();
  });

  afterEach(() => {
    resetAllStubs();
    resetAccessControlDeps();
  });

  // 非 UUID 遗留引用必须被过滤；合法大写与 nil UUID 需按 PostgreSQL 规范形式匹配行和权限。
  test("listSkills 过滤坏引用并规范化合法 UUID", async () => {
    const selectCalls = installSkillDb([
      skillRow(LOWERCASE_UUID, "uppercase-shared"),
      skillRow(NIL_UUID, "nil-shared"),
    ]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        {
          organizationId: "org-source",
          resourceType: "skill",
          resourceId: "legacy-skill-id",
          hasPublicRead: true,
        },
        {
          organizationId: "org-source",
          resourceType: "skill",
          resourceId: UPPERCASE_UUID,
          hasPublicRead: true,
        },
        {
          organizationId: "org-source",
          resourceType: "skill",
          resourceId: NIL_UUID,
          hasPublicRead: false,
        },
      ],
      listOwnedByOrganization: async () => [],
    });

    const rows = await listSkills(ctx);

    expect(selectCalls()).toBe(2);
    expect(rows.map((row) => row.id)).toEqual([LOWERCASE_UUID, NIL_UUID]);
    expect(rows.map((row) => row.resourceAccess.publicReadable)).toEqual([true, false]);
  });

  // 全部权限引用非法时只查询当前组织，不应执行会触发 PostgreSQL UUID 转换错误的外部查询。
  test("listSkills 在引用全部非法时跳过外部查询", async () => {
    const selectCalls = installSkillDb([]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        {
          organizationId: "org-source",
          resourceType: "skill",
          resourceId: "legacy-skill-id",
          hasPublicRead: true,
        },
      ],
      listOwnedByOrganization: async () => [],
    });

    await expect(listSkills(ctx)).resolves.toEqual([]);
    expect(selectCalls()).toBe(1);
  });
});
