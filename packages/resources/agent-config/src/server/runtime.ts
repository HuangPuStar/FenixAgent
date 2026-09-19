import type { AgentConfigServerModule } from "./module";

/**
 * AgentConfig 资源模块的进程级装配结果。
 *
 * 宿主启动流程调用 `createAgentConfigServerModule` 后经 {@link installAgentConfigModule} 装入；路由
 * 与系统路径都在调用时读取它，测试可整体替换为替身。
 *
 * 未装配时 {@link getAgentConfigModule} 直接报错：静默退化会让所有 Agent 端点以"资源不存在"响应，
 * 把装配故障伪装成业务结果。
 *
 * 本文件是包导出面 `./server/runtime` 的入口：宿主只需要装配结果时从这里导入，不要经 `./server`
 * barrel——barrel 会连带导出 HTTP 路由（elysia 端点、`@server/errors`、agent-runtime 的动态入口），
 * 把调用方拉进宿主的依赖图（mcp / skill 包同一入口的注释记录了这类环的历史成因）。
 */

let installed: AgentConfigServerModule | null = null;

/** 装入装配结果；由宿主启动流程调用，测试用同一入口注入替身。 */
export function installAgentConfigModule(module: AgentConfigServerModule): void {
  installed = module;
}

/** 读取装配结果；未装配即报错，不做兜底实现。 */
export function getAgentConfigModule(): AgentConfigServerModule {
  if (!installed) {
    throw new Error("AgentConfig 资源模块未装配：宿主启动流程必须先装配 access-control 与身份目录");
  }
  return installed;
}

/** 清除装配结果，防止跨测试文件共享状态。 */
export function resetAgentConfigModule(): void {
  installed = null;
}
