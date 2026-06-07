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

function skillRow(overrides: Partial<ReturnType<typeof baseSkillRow>>) {
  return { ...baseSkillRow(), ...overrides };
}

function baseSkillRow() {
  return {
    id: "skill_internal",
    userId: "user_owner",
    organizationId: "org_current",
    name: "shared",
    description: "internal skill",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function queryResult<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
  });
}

function installDb(selectResults: unknown[][], options: { insertId?: string; deleteRows?: unknown[] } = {}) {
  const calls = {
    update: 0,
    delete: 0,
    insertValues: undefined as unknown,
  };

  stubDb({
    select: () => ({
      from: () => ({
        where: () => queryResult(selectResults.shift() ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          calls.update += 1;
        },
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        calls.insertValues = value;
        return {
          returning: async () => [{ id: options.insertId ?? "skill_created" }],
        };
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          calls.delete += 1;
          return options.deleteRows ?? [{ id: "skill_deleted" }];
        },
      }),
    }),
  });

  return calls;
}

describe("config skill resource access", () => {
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

  // 内部和外部同名 skill 同时返回，并通过 resourceKey 保持稳定身份
  test("listSkills 返回内部和外部同名 skill", async () => {
    const internal = skillRow({ id: "skill_internal", organizationId: "org_current", description: "internal" });
    const external = skillRow({
      id: "skill_external",
      organizationId: "org_source",
      userId: "user_source",
      description: "external",
    });
    installDb([[internal], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "skill", resourceId: "skill_external", hasPublicRead: true },
      ],
      listOwnedByOrganization: async () => [
        {
          organizationId: "org_current",
          resourceType: "skill",
          resourceId: "skill_internal",
          grantCount: 1,
          hasPublicRead: true,
        },
      ],
    });

    const { listSkills } = await import("../services/config/skill");
    const rows = await listSkills(ctx);

    expect(rows.map((row) => row.resourceAccess.resourceKey)).toEqual([
      "org_current/skill_internal",
      "org_source/skill_external",
    ]);
    expect(rows[0].resourceAccess).toMatchObject({ ownership: "internal", writable: true, publicReadable: true });
    expect(rows[1].resourceAccess).toMatchObject({ ownership: "external", writable: false });
  });

  // 无内部同名时，getSkill(name) 可读取外部授权 skill 且不可写
  test("getSkill 无内部同名时返回外部授权 skill", async () => {
    const external = skillRow({ id: "skill_external", organizationId: "org_source", userId: "user_source" });
    installDb([[], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "skill", resourceId: "skill_external", hasPublicRead: true },
      ],
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { getSkill } = await import("../services/config/skill");
    const row = await getSkill(ctx, "shared");

    expect(row?.id).toBe("skill_external");
    expect(row?.resourceAccess.writable).toBe(false);
    expect(row?.resourceAccess.resourceKey).toBe("org_source/skill_external");
  });

  // upsertSkill 携带 publicReadable 时通过权限 service 写入公开授权
  test("upsertSkill publicReadable 创建公开授权", async () => {
    let capturedGrant: unknown;
    installDb([[]], { insertId: "skill_created" });
    stubResourcePermissionRepo({
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

    const { upsertSkill } = await import("../services/config/skill");
    const id = await upsertSkill(ctx, "shared", { description: "desc", metadata: {} }, { publicReadable: true });

    expect(id).toBe("skill_created");
    expect(capturedGrant).toEqual({
      organizationId: "org_current",
      resourceType: "skill",
      resourceId: "skill_created",
      principalType: "all",
      principalId: null,
      action: "read",
      createdBy: "user_owner",
    });
  });

  // deleteSkill 命中外部资源时抛 403，且不会执行 DB 删除
  test("deleteSkill 拒绝删除外部 skill", async () => {
    const external = skillRow({ id: "skill_external", organizationId: "org_source", userId: "user_source" });
    const calls = installDb([[], [external]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "skill", resourceId: "skill_external", hasPublicRead: true },
      ],
      canReadExternalResource: async () => true,
      listOwnedByOrganization: async () => [],
    });

    const { deleteSkill } = await import("../services/config/skill");
    await expect(deleteSkill(ctx, "shared")).rejects.toThrow(AppError);
    expect(calls.delete).toBe(0);
  });
});
