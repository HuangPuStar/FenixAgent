import { describe, expect, mock, test } from "bun:test";
import { syncBuiltinSkillsToSystemAdmin } from "../services/meta-agent";
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
