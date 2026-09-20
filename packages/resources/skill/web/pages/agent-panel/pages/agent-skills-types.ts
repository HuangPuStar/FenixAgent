import type { SkillResourceLike } from "../../../lib/skill-resource-access";

/** 目录页消费的 skill 视图；授权判断由 `lib/skill-resource-access` 基于 `scope` / `access` 完成。 */
export type SkillInfo = SkillResourceLike & {
  description?: string;
};

export type SkillCreateMode = "text" | "upload";
export type SkillCatalogScope = "all" | "organization" | "public";
