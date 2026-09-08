import { getSkillOptionLabel } from "../../../lib/skill-resource-access";
import type { SkillCatalogScope, SkillInfo } from "./agent-skills-types";

export type SkillFormValidationErrorKey = "form.nameRequired" | "form.contentRequired";

/**
 * 返回手动创建/编辑 skill 表单的首个必填校验错误。
 */
export function getSkillFormValidationError(name: string, content: string): SkillFormValidationErrorKey | null {
  if (!name.trim()) return "form.nameRequired";
  if (!content.trim()) return "form.contentRequired";
  return null;
}

/** 按组织归属、公开读取权限与搜索词筛选技能。 */
export function filterSkills(skills: SkillInfo[], query: string, scope: SkillCatalogScope): SkillInfo[] {
  const keyword = query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (scope === "organization" && skill.resourceAccess?.ownership === "external") return false;
    if (scope === "public" && skill.resourceAccess?.publicReadable !== true) return false;
    if (!keyword) return true;
    return [skill.name, skill.description, getSkillOptionLabel(skill)].join(" ").toLowerCase().includes(keyword);
  });
}

/** 返回技能目录中本组织与明确公开资源的数量。 */
export function countSkillsByScope(skills: SkillInfo[]): {
  organization: number;
  public: number;
} {
  return {
    organization: skills.filter((skill) => skill.resourceAccess?.ownership !== "external").length,
    public: skills.filter((skill) => skill.resourceAccess?.publicReadable === true).length,
  };
}
