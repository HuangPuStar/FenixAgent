import { describe, expect, test } from "bun:test";
import {
  countSkillsByScope,
  filterSkills,
  getSkillFormValidationError,
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

describe("skill catalog filtering", () => {
  // 本组织筛选依据归属；公开筛选仅包含后端明确标记 publicReadable 的资源。
  test("filters organization and public skills by their distinct access fields", () => {
    const publicInternal = {
      ...skills[0],
      name: "public-research",
      resourceAccess: {
        ...skills[0].resourceAccess,
        resourceUid: "skill-public-research",
        resourceKey: "public-research",
        publicReadable: true,
      },
    };
    const catalog = [...skills, publicInternal];

    expect(filterSkills(catalog, "", "organization").map((skill) => skill.name)).toEqual([
      "research",
      "public-research",
    ]);
    expect(filterSkills(catalog, "", "public").map((skill) => skill.name)).toEqual(["public-research"]);
    expect(countSkillsByScope(catalog)).toEqual({ organization: 2, public: 1 });
  });

  // 外部可读资源不等于公开资源，缺少 publicReadable 标记时不能进入公开筛选。
  test("does not treat every external skill as public", () => {
    expect(filterSkills(skills, "", "public")).toEqual([]);
    expect(countSkillsByScope(skills)).toEqual({ organization: 1, public: 0 });
  });

  // 搜索同时覆盖技能名、说明与来源组织展示名。
  test("searches names, descriptions and organization labels", () => {
    expect(filterSkills(skills, "可信", "all").map((skill) => skill.name)).toEqual(["research"]);
    expect(filterSkills(skills, "共享组织", "all").map((skill) => skill.name)).toEqual(["review"]);
  });
});
