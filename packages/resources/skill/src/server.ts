/** Skill 服务端公开入口：资源注册、装配结果与 HTTP 路由。 */

export { SKILL_RESOURCE_TYPE, skillResource } from "./server/access/skill-resource";
export type {
  SkillCreateInput,
  SkillDetailView,
  SkillFacadeApi,
  SkillImportResult,
  SkillListItem,
  SkillUpdateOptions,
  SkillWriteInput,
} from "./server/facades/skill-facade";
export { createSkillServerModule, type SkillModuleDeps, type SkillServerModule } from "./server/module";
export { default as apiSkillsRoutes } from "./server/routes/api/skills";
export { default as skillDownloadRoutes } from "./server/routes/skills";
export { default as webSkillsConfigRoutes } from "./server/routes/web/config/skills";
export { getSkillServerModule, installSkillServerModule } from "./server/runtime";
export * from "./server/services/config/agent-config-skill";
export type { SkillSystemApi, SkillSystemRecord } from "./server/services/skill-system";
