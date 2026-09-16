import { describe, expect, test } from "bun:test";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillLookupKey,
  getSkillOptionLabel,
  getSkillOptionValue,
  getSkillResourceBadgeKey,
  mapSkillOptions,
  normalizeSkillOptionsPayload,
  type SkillOptionLike,
} from "../lib/skill-resource-access";
import type { ResourceAccess } from "../types/config";

function access(overrides: Partial<ResourceAccess> = {}): ResourceAccess {
  return {
    ownership: "internal",
    sourceOrganizationId: "org-1",
    resourceUid: "skill-uid",
    resourceKey: "org-1/skill-key",
    manageable: true,
    writable: true,
    ...overrides,
  };
}

function skill(overrides: Partial<SkillOptionLike> = {}): SkillOptionLike {
  return { id: "skill-id", name: "技能", ...overrides };
}

describe("skill-resource-access 纯转换空值与边界", () => {
  test.each([
    ["资源键", skill({ resourceAccess: access() }), "org-1/skill-key"],
    ["空资源键", skill({ resourceAccess: access({ resourceKey: "" }) }), ""],
    ["数字资源键", skill({ resourceAccess: access({ resourceKey: "0" }) }), "0"],
    ["包含斜杠的资源键", skill({ resourceAccess: access({ resourceKey: "a/b/c" }) }), "a/b/c"],
    ["无资源访问时的标识", skill(), "skill-id"],
    ["空标识", skill({ id: "" }), ""],
    ["无标识时的名称", skill({ id: undefined }), "技能"],
    ["空名称", skill({ id: undefined, name: "" }), ""],
  ])("getSkillKey 保留%s", (_label, input, expected) => {
    expect(getSkillKey(input)).toBe(expected);
  });

  test.each([
    ["资源键", skill({ resourceAccess: access() }), "org-1/skill-key"],
    ["空资源键", skill({ resourceAccess: access({ resourceKey: "" }) }), ""],
    ["数字资源键", skill({ resourceAccess: access({ resourceKey: "0" }) }), "0"],
    ["包含空格的资源键", skill({ resourceAccess: access({ resourceKey: "团队 / 技能" }) }), "团队 / 技能"],
    ["无资源访问", skill(), "技能"],
    ["有标识但无资源访问", skill({ id: "other" }), "技能"],
    ["空名称", skill({ name: "" }), ""],
    ["Unicode 名称", skill({ name: "部署🚀" }), "部署🚀"],
  ])("getSkillLookupKey 保留%s", (_label, input, expected) => {
    expect(getSkillLookupKey(input)).toBe(expected);
  });

  test.each([
    ["资源 UID", skill({ resourceAccess: access() }), "skill-uid"],
    ["空资源 UID", skill({ resourceAccess: access({ resourceUid: "" }) }), ""],
    ["数字资源 UID", skill({ resourceAccess: access({ resourceUid: "0" }) }), "0"],
    ["包含斜杠的资源 UID", skill({ resourceAccess: access({ resourceUid: "org/uid" }) }), "org/uid"],
    ["无资源访问时的标识", skill(), "skill-id"],
    ["空标识", skill({ id: "" }), ""],
    ["无标识时的名称", skill({ id: undefined }), "技能"],
    ["空名称", skill({ id: undefined, name: "" }), ""],
  ])("getSkillOptionValue 保留%s", (_label, input, expected) => {
    expect(getSkillOptionValue(input)).toBe(expected);
  });

  test.each([
    ["来源组织", skill({ resourceAccess: access({ sourceOrganizationName: "研发部" }) }), "研发部/技能"],
    ["空来源组织", skill({ resourceAccess: access({ sourceOrganizationName: "" }) }), "技能"],
    ["空格来源组织", skill({ resourceAccess: access({ sourceOrganizationName: " " }) }), " /技能"],
    ["数字来源组织", skill({ resourceAccess: access({ sourceOrganizationName: "0" }) }), "0/技能"],
    ["无来源组织", skill({ resourceAccess: access() }), "技能"],
    ["无资源访问", skill(), "技能"],
    ["空技能名", skill({ name: "" }), ""],
    ["Unicode 技能名", skill({ name: "代码审查" }), "代码审查"],
  ])("getSkillOptionLabel 转换%s", (_label, input, expected) => {
    expect(getSkillOptionLabel(input)).toBe(expected);
  });

  test.each([
    ["外部资源", skill({ resourceAccess: access({ ownership: "external" }) }), "resource.external"],
    ["内部公开资源", skill({ resourceAccess: access({ publicReadable: true }) }), "resource.public"],
    ["内部非公开资源", skill({ resourceAccess: access({ publicReadable: false }) }), "resource.internal"],
    ["内部缺失公开标记", skill({ resourceAccess: access() }), "resource.internal"],
    [
      "外部公开资源优先外部",
      skill({ resourceAccess: access({ ownership: "external", publicReadable: true }) }),
      "resource.external",
    ],
    ["无资源访问", skill(), "resource.internal"],
    [
      "外部不可写资源",
      skill({ resourceAccess: access({ ownership: "external", writable: false }) }),
      "resource.external",
    ],
    ["内部可管理资源", skill({ resourceAccess: access({ manageable: true }) }), "resource.internal"],
  ])("getSkillResourceBadgeKey 转换%s", (_label, input, expected) => {
    expect(getSkillResourceBadgeKey(input)).toBe(expected);
  });

  test.each([
    ["缺失资源访问", skill(), true, false],
    ["可写且可管理", skill({ resourceAccess: access() }), true, true],
    ["不可写但可管理", skill({ resourceAccess: access({ writable: false }) }), false, true],
    ["可写但不可管理", skill({ resourceAccess: access({ manageable: false }) }), true, false],
    ["均不可用", skill({ resourceAccess: access({ writable: false, manageable: false }) }), false, false],
    ["外部默认可写", skill({ resourceAccess: access({ ownership: "external" }) }), true, true],
    ["外部只读", skill({ resourceAccess: access({ ownership: "external", writable: false }) }), false, true],
    ["外部不可管理", skill({ resourceAccess: access({ ownership: "external", manageable: false }) }), true, false],
  ])("写入和共享权限处理%s", (_label, input, writable, manageable) => {
    expect(canWriteSkill(input)).toBe(writable);
    expect(canManageSkillSharing(input)).toBe(manageable);
  });

  test.each([
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

  test.each([
    ["直接数组", [skill()], "skill-id"],
    ["历史包装", { skills: [skill()] }, "skill-id"],
    ["空描述", [skill({ description: "" })], "skill-id"],
    ["缺失描述", [skill({ description: undefined })], "skill-id"],
    ["空标识", [skill({ id: "" })], ""],
    ["无标识", [skill({ id: undefined })], "技能"],
    ["外部资源", [skill({ resourceAccess: access({ ownership: "external" }) })], "skill-uid"],
    ["空资源 UID", [skill({ resourceAccess: access({ resourceUid: "" }) })], ""],
  ])("normalizeSkillOptionsPayload 转换%s", (_label, payload, expectedId) => {
    expect(normalizeSkillOptionsPayload(payload)[0]?.id).toBe(expectedId);
  });

  test.each([
    ["不修改技能数组", [skill(), skill({ id: "two" })]],
    ["不修改技能对象", [skill({ description: "说明" })]],
    ["不修改资源访问对象", [skill({ resourceAccess: access() })]],
    ["不修改嵌套来源组织", [skill({ resourceAccess: access({ sourceOrganizationName: "团队" }) })]],
    ["不修改空描述", [skill({ description: "" })]],
    ["不修改空标识", [skill({ id: "" })]],
    ["不修改外部资源", [skill({ resourceAccess: access({ ownership: "external" }) })]],
    [
      "不修改多个不同资源",
      [skill({ resourceAccess: access() }), skill({ id: "two", resourceAccess: access({ resourceUid: "uid-2" }) })],
    ],
  ])("mapSkillOptions 对%s保持输入不可变", (_label, input) => {
    const before = structuredClone(input);
    const result = mapSkillOptions(input);

    result[0]!.name = "已修改";
    expect(input).toEqual(before);
  });
});
