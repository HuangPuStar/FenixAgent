import { ApiError } from "@fenix/web-runtime/api/request";
import { getSkillOptionLabel, isExternalSkill, isPublicSkill } from "../../../lib/skill-resource-access";
import type { SkillCatalogScope, SkillInfo } from "./agent-skills-types";

export type SkillFormValidationErrorKey = "form.nameRequired" | "form.contentRequired";

/**
 * 授权类失败的错误码集合。
 *
 * 两个码都要认，因为它们来自同一路由的不同出口：`FORBIDDEN` 是本包后端的值（`SkillFacade` 的
 * `ResourceAccessDeniedError` 经 `runWebHandler` 出 403 + `code: "FORBIDDEN"`，见
 * `src/server/routes/web/config/skill-route-support.ts`），`UNAUTHORIZED` 是「已认证但缺组织上下文」
 * 时的 401 码。`@fenix/web-runtime/api/request` 只在响应**没有** code 时才按 HTTP 状态归一
 * （401/403 → `UNAUTHORIZED`），带 code 的响应原样透传——只认 `UNAUTHORIZED` 会漏掉本包全部 403。
 */
const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/**
 * 判断技能目录加载失败是否属于「无权限」（401/403）。
 *
 * 调用方据此把授权失败与网络/服务端故障分开渲染：授权失败重试多少次都是同一个结果，界面不该给
 * 重试入口（`AgentSkillsCatalog` 的无权限分支即按此判定接管整页）。
 */
export function isSkillAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && ACCESS_DENIED_CODES.has(error.code);
}

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
