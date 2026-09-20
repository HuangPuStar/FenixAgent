/**
 * Skill 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；跨包引用会经
 * 对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），由
 * `web/__tests__/skill-browser-surface.test.ts` 静态走值导入图守护（参照 chat-channel / 沙盒的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 当前消费方（1.6 owner 接线前的现状，均经 `apps/web/vite.config.ts` 的别名指向包内文件）：
 *   - `apps/web/src/routes/agent/_panel/skills.tsx` → `AgentSkillsPage`
 *   - `apps/web/src/components/PermissionTab.tsx` → `skillConfigApi`
 *   - `apps/web/src/__tests__/agent-form-dialog-pure-logic.test.ts` → `lib/skill-resource-access` 的纯函数
 * 三者都在本入口的导出面内，别名可无缺口地改为 `@fenix/resource-skill/web`。
 * i18n 资源另走 `./web/i18n` 子路径：宿主 i18n 模块在应用启动期求值，从本入口取会把整棵页面图
 * 拉进首屏 bundle（详见 `web/i18n/index.ts` 的说明）。
 */

export { type SkillData, skillConfigApi } from "./api/skills";
export { SKILL_NS, type SkillResources, skillResources } from "./i18n";
export * from "./lib/skill-resource-access";
export * from "./lib/skill-upload";
export { AgentSkillsPage } from "./pages/agent-panel/pages/AgentSkillsPage";
export type { SkillCatalogScope, SkillCreateMode, SkillInfo } from "./pages/agent-panel/pages/agent-skills-types";
export {
  countSkillsByScope,
  filterSkills,
  getSkillFormValidationError,
  isSkillAccessDenied,
  type SkillFormValidationErrorKey,
} from "./pages/agent-panel/pages/agent-skills-utils";
