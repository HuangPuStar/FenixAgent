import type { ModelManagementServerModule } from "./module";

/**
 * Provider / Model 资源模块的进程级装配结果。
 *
 * 宿主启动流程调用 `createModelManagementServerModule` 后经 {@link installModelManagementModule} 装入；
 * 路由与系统路径（模型网关的 provider 初始化与模型投影同步）都在调用时读取它，测试可整体替换为替身。
 *
 * 未装配时 {@link getModelManagementModule} 直接报错：静默退化会让所有 Provider 端点以"资源不存在"
 * 响应，把装配故障伪装成业务结果。
 *
 * 文件名不带 `runtime.ts`：本包已有 `src/server/model-gateway/runtime.ts`（模型网关运行时），
 * 两个"运行时"混在一起会让导入路径难以区分。职责与 mcp / agent-config 的 `src/server/runtime.ts`
 * 完全对应。
 */

let installed: ModelManagementServerModule | null = null;

/** 装入装配结果；由宿主启动流程调用，测试用同一入口注入替身。 */
export function installModelManagementModule(module: ModelManagementServerModule): void {
  installed = module;
}

/** 读取装配结果；未装配即报错，不做兜底实现。 */
export function getModelManagementModule(): ModelManagementServerModule {
  if (!installed) {
    throw new Error("Provider 资源模块未装配：宿主启动流程必须先装配 access-control 与身份目录");
  }
  return installed;
}

/** 清除装配结果，防止跨测试文件共享状态。 */
export function resetModelManagementModule(): void {
  installed = null;
}
