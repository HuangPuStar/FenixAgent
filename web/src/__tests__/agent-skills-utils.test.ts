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
  // 归属筛选只能依据后端明确返回的 internal/external，不推测个人或平台范围。
  test("filters organization and shared skills by proven ownership", () => {
    expect(filterSkills(skills, "", "organization").map((skill) => skill.name)).toEqual(["research"]);
    expect(filterSkills(skills, "", "shared").map((skill) => skill.name)).toEqual(["review"]);
    expect(countSkillsByScope(skills)).toEqual({ organization: 1, shared: 1 });
  });

  // 本组织公开资源仍属于本组织；外部资源只能证明为共享给我，不能推断为全局公开。
  test("keeps ownership scope separate from public readability", () => {
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
    expect(filterSkills(catalog, "", "shared").map((skill) => skill.name)).toEqual(["review"]);
    expect(countSkillsByScope(catalog)).toEqual({ organization: 2, shared: 1 });
  });

  // 搜索同时覆盖技能名、说明与来源组织展示名。
  test("searches names, descriptions and organization labels", () => {
    expect(filterSkills(skills, "可信", "all").map((skill) => skill.name)).toEqual(["research"]);
    expect(filterSkills(skills, "共享组织", "all").map((skill) => skill.name)).toEqual(["review"]);
  });
});
