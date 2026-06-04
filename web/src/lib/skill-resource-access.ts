import type { ResourceAccess } from "../types/config";

export interface SkillResourceLike {
  id?: string;
  name: string;
  resourceAccess?: ResourceAccess;
}

export interface SkillOptionLike extends SkillResourceLike {
  description?: string;
}

export function getSkillKey(skill: SkillResourceLike) {
  return skill.resourceAccess?.resourceKey ?? skill.id ?? skill.name;
}

export function getSkillLookupKey(skill: SkillResourceLike) {
  return skill.resourceAccess?.resourceKey ?? skill.name;
}

export function canWriteSkill(skill: SkillResourceLike) {
  return skill.resourceAccess?.writable !== false;
}

export function canManageSkillSharing(skill: SkillResourceLike) {
  return skill.resourceAccess?.manageable === true;
}

export function getSkillResourceBadgeKey(skill: SkillResourceLike) {
  if (skill.resourceAccess?.ownership === "external") return "resource.external";
  if (skill.resourceAccess?.publicReadable) return "resource.public";
  return "resource.internal";
}

export function getSkillOptionValue(skill: SkillOptionLike) {
  return skill.resourceAccess?.resourceUid ?? skill.id ?? skill.name;
}

export function getSkillOptionLabel(skill: SkillOptionLike) {
  const source = skill.resourceAccess?.sourceOrganizationName;
  return source ? `${source}/${skill.name}` : skill.name;
}

export function mapSkillOptions(skills: SkillOptionLike[]) {
  return skills.map((skill) => ({
    id: getSkillOptionValue(skill),
    key: getSkillKey(skill),
    name: skill.name,
    label: getSkillOptionLabel(skill),
    description: skill.description ?? "",
    resourceAccess: skill.resourceAccess,
  }));
}
