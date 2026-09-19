import type { SkillServerModule } from "./module";

/**
 * 系统路径的类型随装配结果一起暴露：调用方（builtin 同步）既需要 `system` 的值，也需要它的投影类型，
 * 从同一入口取可以避免为了一个类型去 import 包 barrel。
 */
export type { SkillSystemApi, SkillSystemRecord } from "./services/skill-system";

/**
 * Skill 资源模块的进程级装配结果。
 *
 * 宿主启动流程调用 `createSkillServerModule` 后经 {@link installSkillServerModule} 装入；路由与系统
 * 路径（builtin 同步）都在调用时读取它，测试可整体替换为替身。
 *
 * 未装配时 {@link getSkillServerModule} 直接报错：静默退化会让所有 Skill 端点以"资源不存在"响应，
 * 把装配故障伪装成业务结果。
 *
 * 本文件是包导出面 `./server/runtime` 的入口：宿主与资源包只需要装配结果时从这里导入，不要经
 * `./server` barrel——barrel 会连带导出 HTTP 路由（elysia 端点、`@server/errors`、下载 token），把
 * 调用方拉进宿主的依赖图，在宿主服务与资源包之间形成环（见
 * `scripts/architecture/exceptions.json` 的 no-circular 说明，mcp 包同一入口的注释记录了历史成因）。
 */

let installed: SkillServerModule | null = null;

/** 装入装配结果；由宿主启动流程调用，测试用同一入口注入替身。 */
export function installSkillServerModule(module: SkillServerModule): void {
  installed = module;
}

/** 读取装配结果；未装配即报错，不做兜底实现。 */
export function getSkillServerModule(): SkillServerModule {
  if (!installed) {
    throw new Error("Skill 资源模块未装配：宿主启动流程必须先装配 access-control 与身份目录");
  }
  return installed;
}

/** 清除装配结果，防止跨测试文件共享状态。 */
export function resetSkillServerModule(): void {
  installed = null;
}
