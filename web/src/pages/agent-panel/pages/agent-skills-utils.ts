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

/** 按后端可证明的组织归属与搜索词筛选技能，不推测个人或平台范围。 */
export function filterSkills(skills: SkillInfo[], query: string, scope: SkillCatalogScope): SkillInfo[] {
  const keyword = query.trim().toLowerCase();
  return skills.filter((skill) => {
    const external = skill.resourceAccess?.ownership === "external";
    if (scope === "organization" && external) return false;
    if (scope === "shared" && !external) return false;
    if (!keyword) return true;
    return [skill.name, skill.description, getSkillOptionLabel(skill)].join(" ").toLowerCase().includes(keyword);
  });
}

/** 返回技能目录中真实可判定的组织内与共享资源数量。 */
export function countSkillsByScope(skills: SkillInfo[]): { organization: number; shared: number } {
  const organization = skills.filter((skill) => skill.resourceAccess?.ownership !== "external").length;
  return { organization, shared: skills.length - organization };
}
