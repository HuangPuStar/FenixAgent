import { describe, expect, mock, test } from "bun:test";
import { syncBuiltin } from "@server/services/sync-builtin";
import { selectSystemBuiltinSkillId, syncBuiltinSkillsToSystemAdmin } from "../services/meta-agent";

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
  // 传入集合已限定在系统托管组织内，因此只按 meta-builtin 标记挑选：业务组织同名 skill 根本不在集合里。
  test("selects the marked builtin among same-name rows", () => {
    const selected = selectSystemBuiltinSkillId(
      [
        { id: "user-created", name: "show-html-or-picture", metadata: null },
        { id: "system-builtin", name: "show-html-or-picture", metadata: { source: "meta-builtin" } },
      ],
      "show-html-or-picture",
    );

    expect(selected).toBe("system-builtin");
  });

  // 同名的用户自建 skill 不能冒充 builtin：没有标记就不绑定。
  test("ignores same-name rows without the builtin marker", () => {
    expect(
      selectSystemBuiltinSkillId([{ id: "user-created", name: "demo", metadata: { source: "user" } }], "demo"),
    ).toBe(null);
  });

  // 集合里没有该名称时返回 null，调用方据此跳过绑定而不是回落到任意同名资源。
  test("returns null when no same-name builtin exists", () => {
    expect(
      selectSystemBuiltinSkillId([{ id: "other", name: "other", metadata: { source: "meta-builtin" } }], "demo"),
    ).toBe(null);
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
