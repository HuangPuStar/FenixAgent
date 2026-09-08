import type { ResourceAccess } from "../../../types/config";

export type SkillInfo = {
  id?: string;
  name: string;
  description?: string;
  resourceAccess?: ResourceAccess;
};

export type SkillCreateMode = "text" | "upload";
export type SkillCatalogScope = "all" | "organization" | "public";
