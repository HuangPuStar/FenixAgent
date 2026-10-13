import { describe, expect, test } from "bun:test";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillLookupKey,
  getSkillOptionLabel,
  getSkillOptionValue,
  getSkillResourceBadgeKey,
  isExternalSkill,
  isPublicSkill,
  mapSkillOptions,
  normalizeSkillOptionsPayload,
  type SkillOptionLike,
} from "../lib/skill-resource-access";

const ACTIVE_ORG_ID = "org-current";

/** 本组织私有 Skill：归属当前组织，带 update 动作。 */
function internalSkill(overrides: Partial<SkillOptionLike> = {}): SkillOptionLike {
  return {
    id: "skill-id",
    name: "技能",
    scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
    access: { actions: ["read", "update", "delete"] },
    ...overrides,
  };
}

/** 外部组织公开 Skill：归属其他组织，只有读动作。 */
function externalSkill(overrides: Partial<SkillOptionLike> = {}): SkillOptionLike {
  return {
    id: "skill-external",
    name: "技能",
    scope: { organizationId: "org-source", visibility: "public" },
    access: { actions: ["read"] },
    organizationName: "Source Team",
    ...overrides,
  };
}

describe("skill-resource-access 纯转换空值与边界", () => {
  test.each<[string, SkillOptionLike, string]>([
    ["本组织私有资源", internalSkill(), "org-current/skill-id"],
    ["外部组织资源", externalSkill(), "org-source/skill-external"],
    ["空标识", internalSkill({ id: "" }), "技能"],
    ["无标识", internalSkill({ id: undefined }), "技能"],
    ["无归属组织", { id: "skill-id", name: "技能" }, "技能"],
    ["无归属组织但有标识", { id: "skill-id", name: "技能", scope: { visibility: "private" } }, "技能"],
    ["空名称", internalSkill({ id: undefined, name: "" }), ""],
    ["Unicode 名称", internalSkill({ id: undefined, name: "部署🚀" }), "部署🚀"],
  ])("getSkillKey 推导%s", (_label, input, expected) => {
    expect(getSkillKey(input)).toBe(expected);
  });

  // 详情接口的 name 参数同时承载技能名与跨组织资源键，查找键必须与稳定键一致。
  test.each<[string, SkillOptionLike, string]>([
    ["外部组织资源", externalSkill(), "org-source/skill-external"],
    ["本组织资源", internalSkill(), "org-current/skill-id"],
    ["无归属信息", { name: "技能" }, "技能"],
    ["空名称", { name: "" }, ""],
  ])("getSkillLookupKey 推导%s", (_label, input, expected) => {
    expect(getSkillLookupKey(input)).toBe(expected);
  });

  test.each<[string, SkillOptionLike, string]>([
    ["资源标识", internalSkill(), "skill-id"],
    ["空标识", internalSkill({ id: "" }), ""],
    ["无标识时退回名称", internalSkill({ id: undefined }), "技能"],
    ["空名称", internalSkill({ id: undefined, name: "" }), ""],
    ["外部资源标识", externalSkill(), "skill-external"],
    ["Unicode 名称", internalSkill({ id: undefined, name: "代码审查" }), "代码审查"],
  ])("getSkillOptionValue 推导%s", (_label, input, expected) => {
    expect(getSkillOptionValue(input)).toBe(expected);
  });

  test.each<[string, SkillOptionLike, string]>([
    ["来源组织", externalSkill(), "Source Team/技能"],
    ["空来源组织", externalSkill({ organizationName: "" }), "技能"],
    ["空格来源组织", externalSkill({ organizationName: " " }), " /技能"],
    ["数字来源组织", externalSkill({ organizationName: "0" }), "0/技能"],
    ["无来源组织", internalSkill(), "技能"],
    ["空技能名", { name: "", organizationName: "团队" }, "团队/"],
    ["Unicode 技能名", internalSkill({ id: undefined, name: "代码审查" }), "代码审查"],
  ])("getSkillOptionLabel 转换%s", (_label, input, expected) => {
    expect(getSkillOptionLabel(input)).toBe(expected);
  });

  // 归属判定比对 scope.organizationId 与当前组织；缺少归属或当前组织未知时按本组织保守处理。
  test.each<[string, SkillOptionLike, string | undefined, boolean]>([
    ["本组织资源", internalSkill(), ACTIVE_ORG_ID, false],
    ["外部组织资源", externalSkill(), ACTIVE_ORG_ID, true],
    ["当前组织未知", externalSkill(), undefined, false],
    ["资源无归属组织", { name: "技能" }, ACTIVE_ORG_ID, false],
    ["外部资源无当前组织", externalSkill(), "", false],
  ])("isExternalSkill 判定%s", (_label, input, active, expected) => {
    expect(isExternalSkill(input, active)).toBe(expected);
  });

  test.each<[string, SkillOptionLike, boolean]>([
    ["本组织公开资源", internalSkill({ scope: { organizationId: ACTIVE_ORG_ID, visibility: "public" } }), true],
    ["本组织私有资源", internalSkill(), false],
    ["外组织公开资源", externalSkill(), true],
    ["缺失归属", { name: "技能" }, false],
  ])("isPublicSkill 判定%s", (_label, input, expected) => {
    expect(isPublicSkill(input)).toBe(expected);
  });

  test.each<[string, SkillOptionLike, string | undefined, string]>([
    ["外部资源", externalSkill(), ACTIVE_ORG_ID, "resource.external"],
    [
      "本组织公开资源",
      internalSkill({ scope: { organizationId: ACTIVE_ORG_ID, visibility: "public" } }),
      ACTIVE_ORG_ID,
      "resource.public",
    ],
    ["本组织私有资源", internalSkill(), ACTIVE_ORG_ID, "resource.internal"],
    ["当前组织未知时外部资源算本组织", externalSkill(), undefined, "resource.public"],
    ["缺失授权视图", { name: "技能" }, ACTIVE_ORG_ID, "resource.internal"],
  ])("getSkillResourceBadgeKey 转换%s", (_label, input, active, expected) => {
    expect(getSkillResourceBadgeKey(input, active)).toBe(expected);
  });

  // 写权限与公开状态管理同源于 update 动作；缺失动作时必须保守判定为不可写。
  test.each<[string, SkillOptionLike, boolean]>([
    ["缺失授权视图", { name: "技能" }, false],
    ["只有读动作", externalSkill(), false],
    ["带更新动作", internalSkill(), true],
    ["动作列表为空", internalSkill({ access: { actions: [] } }), false],
    ["动作字段缺失", internalSkill({ access: {} }), false],
    ["缺失 access", internalSkill({ access: undefined }), false],
  ])("canWriteSkill 与 canManageSkillSharing 判定%s", (_label, input, writable) => {
    expect(canWriteSkill(input)).toBe(writable);
    expect(canManageSkillSharing(input)).toBe(writable);
  });

  test.each<[string, unknown, unknown[]]>([
    ["空数组", [], []],
    ["null", null, []],
    ["undefined", undefined, []],
    ["字符串", "skills", []],
    ["数字", 0, []],
    ["空对象", {}, []],
    ["skills 不是数组", { skills: {} }, []],
    ["skills 为 null", { skills: null }, []],
  ])("normalizeSkillOptionsPayload 对%s安全回退", (_label, payload, expected) => {
    expect(normalizeSkillOptionsPayload(payload)).toEqual(expected);
  });

  test.each<[string, unknown, string]>([
    ["直接数组", [internalSkill()], "skill-id"],
    ["历史包装", { skills: [internalSkill()] }, "skill-id"],
    ["空标识", [internalSkill({ id: "" })], ""],
    ["无标识", [internalSkill({ id: undefined })], "技能"],
    ["外部资源", [externalSkill()], "skill-external"],
  ])("normalizeSkillOptionsPayload 转换%s", (_label, payload, expectedId) => {
    expect(normalizeSkillOptionsPayload(payload)[0]?.id).toBe(expectedId);
  });

  // 选项透传授权视图字段供调用方分组，同时保留稳定 key 与名称。
  test("mapSkillOptions 透传归属与展示字段", () => {
    expect(mapSkillOptions([externalSkill({ description: "Review code" })])).toEqual([
      {
        id: "skill-external",
        key: "org-source/skill-external",
        name: "技能",
        label: "Source Team/技能",
        description: "Review code",
        scope: { organizationId: "org-source", visibility: "public" },
        organizationName: "Source Team",
      },
    ]);
  });

  test.each<[string, SkillOptionLike[]]>([
    ["不修改技能数组", [internalSkill(), internalSkill({ id: "two" })]],
    ["不修改技能对象", [internalSkill({ description: "说明" })]],
    ["不修改归属对象", [internalSkill({ scope: { organizationId: "org-source", visibility: "public" } })]],
    ["不修改来源组织", [externalSkill()]],
    ["不修改空描述", [internalSkill({ description: "" })]],
    ["不修改空标识", [internalSkill({ id: "" })]],
    ["不修改多个不同资源", [internalSkill(), externalSkill()]],
  ])("mapSkillOptions 对%s保持输入不可变", (_label, input) => {
    const before = structuredClone(input);
    const result = mapSkillOptions(input);

    result[0]!.name = "已修改";
    expect(input).toEqual(before);
  });
});
