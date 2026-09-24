import type { PluginMarketServerModule } from "./module";

/**
 * 插件市场模块的进程级装配结果。
 *
 * 宿主启动流程调用 `createPluginMarketServerModule` 后经 {@link installPluginMarketModule} 装入；路由与
 * 系统路径都在调用时读取它，测试可整体替换为替身。
 *
 * 未装配时 {@link getPluginMarketModule} 直接报错：静默退化会让所有市场端点以「资源不存在」响应，
 * 把装配故障伪装成业务结果。
 *
 * 本文件是包导出面 `./server/runtime` 的入口：宿主只需要装配结果时从这里导入，不要经 `./server`
 * barrel——barrel 会连带导出 HTTP 路由，把 Elysia 及其宿主依赖拉进导入方所在的依赖图。
 */

let installed: PluginMarketServerModule | null = null;

/** 装入装配结果；由宿主启动流程调用，测试用同一入口注入替身。 */
export function installPluginMarketModule(module: PluginMarketServerModule): void {
  installed = module;
}

/** 读取装配结果；未装配即报错，不做兜底实现。 */
export function getPluginMarketModule(): PluginMarketServerModule {
  if (!installed) {
    throw new Error("插件市场模块未装配：宿主启动流程必须先装配 access-control 与身份目录");
  }
  return installed;
}

/** 清除装配结果，防止跨测试文件共享状态。 */
export function resetPluginMarketModule(): void {
  installed = null;
}
