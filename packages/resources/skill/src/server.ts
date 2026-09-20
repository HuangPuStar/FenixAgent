/**
 * Skill 服务端公开入口：资源注册、装配结果、模块配置与 HTTP 路由。
 *
 * 依赖方向：宿主 `apps/server`、`@fenix/resource-agent-config` 与 `@fenix/agent-runtime` 是合法
 * 消费者。带认证的两条路由一律以工厂形式导出，守卫由宿主注入（理由见 `./server/routes/dependencies`）；
 * `/skills/:name/download` 用令牌自身授权，按实例导出。本入口不含浏览器代码（浏览器面走 `./web`）。
 */

export { SKILL_RESOURCE_TYPE, skillResource } from "./server/access/skill-resource";
export type { SkillModuleConfig } from "./server/config";
export { getSkillConfig } from "./server/config";
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
export { createApiSkillsRoutes } from "./server/routes/api/skills";
export type { SkillRouteDependencies } from "./server/routes/dependencies";
export { skillDownloadRoutes } from "./server/routes/skills";
export { createWebSkillsConfigRoutes } from "./server/routes/web/config/skills";
export { getSkillServerModule, installSkillServerModule } from "./server/runtime";
export * from "./server/services/config/agent-config-skill";
export type { SkillSystemApi, SkillSystemRecord } from "./server/services/skill-system";
