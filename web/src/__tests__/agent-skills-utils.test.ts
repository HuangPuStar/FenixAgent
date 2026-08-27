import { describe, expect, test } from "bun:test";
import {
  countSkillsByScope,
  filterSkills,
  getSkillFormValidationError,
  getSkillOrganizationBadgeStyle,
} from "../pages/agent-panel/pages/agent-skills-utils";
import type { ResourceAccess } from "../types/config";

const skills = [
  {
    name: "research",
    description: "检索可信资料",
    resourceAccess: {
      ownership: "internal",
      sourceOrganizationId: "org-current",
      resourceUid: "skill-research",
      resourceKey: "research",
      manageable: true,
      writable: true,
    } satisfies ResourceAccess,
  },
  {
    name: "review",
    description: "检查代码风险",
    resourceAccess: {
      ownership: "external",
      sourceOrganizationId: "org-a",
      sourceOrganizationName: "共享组织",
      resourceUid: "skill-review",
      resourceKey: "org-a/review",
      manageable: false,
      writable: false,
    } satisfies ResourceAccess,
  },
];

describe("getSkillFormValidationError", () => {
  // 名称为空时应优先返回名称必填提示。
  test("returns nameRequired when name is blank", () => {
    expect(getSkillFormValidationError("", "content")).toBe("form.nameRequired");
    expect(getSkillFormValidationError("   ", "content")).toBe("form.nameRequired");
  });

  // 内容为空时应返回内容必填提示，而不是错误复用名称提示。
  test("returns contentRequired when content is blank", () => {
    expect(getSkillFormValidationError("demo-skill", "")).toBe("form.contentRequired");
    expect(getSkillFormValidationError("demo-skill", "   ")).toBe("form.contentRequired");
  });

  // 名称和内容都填写时不应报校验错误。
  test("returns null when name and content are both present", () => {
    expect(getSkillFormValidationError("demo-skill", "# Skill")).toBeNull();
  });
});

describe("skill organization badge colors", () => {
  // 同一组织的技能应始终得到同一配色，避免筛选或排序后视觉标识变化。
  test("keeps colors stable for the same organization", () => {
    const first = getSkillOrganizationBadgeStyle(skills[1]);
    const second = getSkillOrganizationBadgeStyle({
      ...skills[1],
      name: "another-skill",
    });
    expect(first).toEqual(second);
  });

  // 不同组织应由组织 ID 映射到不同颜色，而不是复用统一的共享 badge 颜色。
  test("uses different colors for different organizations", () => {
    const first = getSkillOrganizationBadgeStyle(skills[1]);
    const second = getSkillOrganizationBadgeStyle({
      ...skills[1],
      resourceAccess: {
        ...skills[1].resourceAccess,
        sourceOrganizationId: "org-b",
      },
    });
    expect(first).not.toEqual(second);
  });

  // 缺少后端组织标识时不应臆造颜色键，交由组件默认样式兜底。
  test("returns undefined without an organization id", () => {
    expect(getSkillOrganizationBadgeStyle({ name: "legacy-skill" })).toBeUndefined();
  });
});

describe("skill catalog filtering", () => {
  // 归属筛选只能依据后端明确返回的 internal/external，不推测个人或平台范围。
  test("filters organization and shared skills by proven ownership", () => {
    expect(filterSkills(skills, "", "organization").map((skill) => skill.name)).toEqual(["research"]);
    expect(filterSkills(skills, "", "shared").map((skill) => skill.name)).toEqual(["review"]);
    expect(countSkillsByScope(skills)).toEqual({ organization: 1, shared: 1 });
  });

  // 搜索同时覆盖技能名、说明与来源组织展示名。
  test("searches names, descriptions and organization labels", () => {
    expect(filterSkills(skills, "可信", "all").map((skill) => skill.name)).toEqual(["research"]);
    expect(filterSkills(skills, "共享组织", "all").map((skill) => skill.name)).toEqual(["review"]);
  });
});
