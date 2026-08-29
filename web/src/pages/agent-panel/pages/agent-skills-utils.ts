import type { CSSProperties } from "react";
import { getSkillOptionLabel } from "../../../lib/skill-resource-access";
import type { SkillCatalogScope, SkillInfo } from "./agent-skills-types";

export type SkillFormValidationErrorKey = "form.nameRequired" | "form.contentRequired";

/** 根据稳定的组织 ID 生成浅色 badge 配色，避免颜色随排序或组织改名变化。 */
export function getSkillOrganizationBadgeStyle(skill: SkillInfo): CSSProperties | undefined {
  const organizationId = skill.resourceAccess?.sourceOrganizationId;
  if (!organizationId) return;

  let hash = 0;
  for (const character of organizationId) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  const hue = hash % 360;
  return {
    backgroundColor: `hsl(${hue} 80% 95%)`,
    borderColor: `hsl(${hue} 55% 82%)`,
    color: `hsl(${hue} 55% 34%)`,
  };
}

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
