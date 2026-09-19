import { describe, expect, test } from "bun:test";
import type { SkillInfo } from "../pages/agent-panel/pages/agent-skills-types";
import {
  countSkillsByScope,
  filterSkills,
  getSkillFormValidationError,
} from "../pages/agent-panel/pages/agent-skills-utils";

const ACTIVE_ORG_ID = "org-current";

const skills: SkillInfo[] = [
  {
    id: "skill-research",
    name: "research",
    description: "检索可信资料",
    scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
    access: { actions: ["read", "update"] },
  },
  {
    id: "skill-review",
    name: "review",
    description: "检查代码风险",
    scope: { organizationId: "org-a", visibility: "public" },
    access: { actions: ["read"] },
    organizationName: "共享组织",
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
  // 本组织筛选依据归属（外部资源被排除），公开筛选依据 scope.visibility，两者互不等价。
  test("filters organization and public skills by their distinct scope fields", () => {
    const publicInternal: SkillInfo = {
      ...skills[0]!,
      id: "skill-public-research",
      name: "public-research",
      scope: { organizationId: ACTIVE_ORG_ID, visibility: "public" },
    };
    const catalog = [...skills, publicInternal];

    expect(filterSkills(catalog, "", "organization", ACTIVE_ORG_ID).map((skill) => skill.name)).toEqual([
      "research",
      "public-research",
    ]);
    expect(filterSkills(catalog, "", "public", ACTIVE_ORG_ID).map((skill) => skill.name)).toEqual([
      "review",
      "public-research",
    ]);
    expect(countSkillsByScope(catalog, ACTIVE_ORG_ID)).toEqual({ organization: 2, public: 2 });
  });

  // 组织上下文未就绪时按本组织保守处理，避免加载瞬间把用户自己的资源筛掉。
  test("treats every skill as internal when the active organization is unknown", () => {
    expect(countSkillsByScope(skills)).toEqual({ organization: 2, public: 1 });
    expect(filterSkills(skills, "", "organization").map((skill) => skill.name)).toEqual(["research", "review"]);
    expect(countSkillsByScope(skills, ACTIVE_ORG_ID)).toEqual({ organization: 1, public: 1 });
  });

  // 搜索同时覆盖技能名、说明与来源组织展示名。
  test("searches names, descriptions and organization labels", () => {
    expect(filterSkills(skills, "可信", "all", ACTIVE_ORG_ID).map((skill) => skill.name)).toEqual(["research"]);
    expect(filterSkills(skills, "共享组织", "all", ACTIVE_ORG_ID).map((skill) => skill.name)).toEqual(["review"]);
  });
});
