import { describe, expect, mock, test } from "bun:test";
import {
  type BuiltinSkillContext,
  selectSystemBuiltinSkillId,
  syncBuiltinSkillsToSystemAdmin,
} from "../server/services/builtin-skills";

/**
 * builtin skill 在系统托管组织内的挑选与公开化。
 *
 * 启动编排（宿主 `apps/server/src/services/sync-builtin.ts` 的 `syncBuiltin`）不在这里覆盖：它属宿主，
 * 包内用例不得 import `@server/*`（1.3 静态条件 1）。宿主侧的等价覆盖登记在 sharedPatches，随 W3 落地。
 */

describe("selectSystemBuiltinSkillId", () => {
  // 传入集合已限定在系统托管组织内，因此只按 meta-builtin 标记挑选：业务组织同名 skill 根本不在集合里。
  test("selects the marked builtin among same-name rows", () => {
    const selected = selectSystemBuiltinSkillId(
      [
        { id: "user-created", name: "show-html-or-picture" },
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
    const syncBuiltinSkillsSpy = mock(async (_ctx: BuiltinSkillContext) => {});
    // 返回 true 表示公开化已落库；false 会走「设置失败」日志分支，那条分支不属本用例语义。
    const setSkillPublicReadableSpy = mock(async (_skillId: string) => true);

    await syncBuiltinSkillsToSystemAdmin(
      { organizationId: "org_admin", userId: "user_admin" },
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
