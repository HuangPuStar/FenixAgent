import type { ChannelServerModule } from "./module";

/**
 * Channel 资源模块的进程级装配结果。
 *
 * 宿主启动流程调用 `createChannelModule` 后经 {@link installChannelModule} 装入；路由在调用时读取同一份
 * 结果，测试可整体替换为替身。
 *
 * 未装配时 {@link getChannelModule} 直接报错：静默退化会让所有通道端点以「资源不存在」响应，把装配故障
 * 伪装成业务结果。
 *
 * 本文件是包导出面 `./server` 的一部分：宿主只需要装配结果时从这里导入，不要经路由文件——路由文件会
 * 连带把 Elysia 端点拉进调用方的静态依赖图。
 */

let installed: ChannelServerModule | null = null;

/** 装入装配结果；由宿主启动流程或 registry 工厂调用，测试用同一入口注入替身。 */
export function installChannelModule(module: ChannelServerModule): void {
  installed = module;
}

/** 读取装配结果；未装配即报错，不做兜底实现。 */
export function getChannelModule(): ChannelServerModule {
  if (!installed) {
    throw new Error("Channel 资源模块未装配：宿主启动流程必须先调用 createChannelModule");
  }
  return installed;
}

/** 清除装配结果，防止跨测试文件共享状态。 */
export function resetChannelModule(): void {
  installed = null;
}
