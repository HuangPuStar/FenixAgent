import { describe, expect, mock, test } from "bun:test";
import { selectSystemBuiltinSkillId, syncBuiltinSkillsToSystemAdmin } from "../services/meta-agent";
import { syncBuiltin } from "../services/sync-builtin";

describe("syncBuiltin", () => {
  // 启动同步 builtin 时，只应把 skill 托管到系统 admin 组织，而不是复制到所有业务组织。
  test("syncs builtin skills only to system admin organization", async () => {
    const syncBuiltinSkillsToSystemAdminSpy = mock(
      async (_ctx: { organizationId: string; userId: string; role: "owner" | "admin" | "member" }) => {},
    );

    await syncBuiltin({
      ensureSystemAdmin: async () => ({
        created: false,
        userId: "user_admin",
        email: "admin@fenix.com",
        organization: { id: "org_admin", slug: "admin" },
      }),
      syncBuiltinSkillsToSystemAdmin: syncBuiltinSkillsToSystemAdminSpy,
    });

    expect(syncBuiltinSkillsToSystemAdminSpy).toHaveBeenCalledTimes(1);
    const firstCtx = syncBuiltinSkillsToSystemAdminSpy.mock.calls[0]?.[0];
    expect(firstCtx).toEqual({
      organizationId: "org_admin",
      userId: "user_admin",
      role: "owner",
    });
  });
});

describe("selectSystemBuiltinSkillId", () => {
  // Meta Agent 只能绑定系统 admin 组织的 builtin，不能绑定业务组织同名 skill。
  test("ignores business organization duplicates and external resources", () => {
    const selected = selectSystemBuiltinSkillId(
      [
        {
          id: "stale-local",
          name: "show-html-or-picture",
          metadata: null,
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "user-org",
            resourceUid: "stale-local",
            resourceKey: "user-org/stale-local",
            manageable: true,
            writable: true,
          },
        },
        {
          id: "system-builtin",
          name: "show-html-or-picture",
          metadata: { source: "meta-builtin" },
          resourceAccess: {
            ownership: "external",
            sourceOrganizationId: "system-org",
            resourceUid: "system-builtin",
            resourceKey: "system-org/system-builtin",
            manageable: false,
            writable: false,
          },
        },
      ],
      "show-html-or-picture",
    );

    expect(selected).toBe(null);
  });

  // 系统 admin 组织中带 meta-builtin 标记的本地 skill 才是合法绑定来源。
  test("selects marked local builtin for system organization", () => {
    expect(
      selectSystemBuiltinSkillId(
        [
          {
            id: "system-builtin",
            name: "show-html-or-picture",
            metadata: { source: "meta-builtin" },
            resourceAccess: {
              ownership: "internal",
              sourceOrganizationId: "system-org",
              resourceUid: "system-builtin",
              resourceKey: "system-org/system-builtin",
              manageable: true,
              writable: true,
            },
          },
        ],
        "show-html-or-picture",
      ),
    ).toBe("system-builtin");
  });
});

describe("syncBuiltinSkillsToSystemAdmin", () => {
  // 内置 skill 托管到 admin 组织后，必须统一设置为公开可读。
  test("marks synced builtin skills as public readable", async () => {
    const syncBuiltinSkillsSpy = mock(async () => {});
    const setSkillPublicReadableSpy = mock(async (_skillId: string) => {});

    await syncBuiltinSkillsToSystemAdmin(
      { organizationId: "org_admin", userId: "user_admin", role: "owner" },
      {
        syncBuiltinSkills: syncBuiltinSkillsSpy,
        listBuiltinSkillIds: async () => ["skill_a", "skill_b"],
        setSkillPublicReadable: setSkillPublicReadableSpy,
      },
    );

    expect(syncBuiltinSkillsSpy).toHaveBeenCalledTimes(1);
    expect(setSkillPublicReadableSpy).toHaveBeenCalledTimes(2);
    expect(setSkillPublicReadableSpy.mock.calls[0]?.[0]).toBe("skill_a");
    expect(setSkillPublicReadableSpy.mock.calls[1]?.[0]).toBe("skill_b");
  });
});
