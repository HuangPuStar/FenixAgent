import { getSkillOptionLabel, isExternalSkill, isPublicSkill } from "../../../lib/skill-resource-access";
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

/**
 * 按组织归属、公开状态与搜索词筛选技能。
 *
 * 组织判定需要当前组织 id（归属其他组织即视为共享来源）；id 缺失时按本组织保守处理，
 * 避免组织上下文未就绪的瞬间把用户自己的资源筛掉。
 */
export function filterSkills(
  skills: SkillInfo[],
  query: string,
  scope: SkillCatalogScope,
  activeOrganizationId?: string,
): SkillInfo[] {
  const keyword = query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (scope === "organization" && isExternalSkill(skill, activeOrganizationId)) return false;
    if (scope === "public" && !isPublicSkill(skill)) return false;
    if (!keyword) return true;
    return [skill.name, skill.description, getSkillOptionLabel(skill)].join(" ").toLowerCase().includes(keyword);
  });
}

/** 返回技能目录中本组织与明确公开资源的数量。 */
export function countSkillsByScope(
  skills: SkillInfo[],
  activeOrganizationId?: string,
): {
  organization: number;
  public: number;
} {
  return {
    organization: skills.filter((skill) => !isExternalSkill(skill, activeOrganizationId)).length,
    public: skills.filter((skill) => isPublicSkill(skill)).length,
  };
}
