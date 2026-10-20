import type { TicketsServerModule } from "./module";

/**
 * 工单资源模块的进程级装配结果槽位（照 `@fenix/resource-mcp/src/server/runtime.ts` 同形）。
 *
 * 装配期由 `src/module.ts` 的 `createTicketsModule` 经 {@link installTicketsServerModule} 装入，路由贡献
 * 与其它启动路径在**请求期**经 {@link getTicketsServerModule} 读取同一份结果。路由贡献在宿主构造 app 时
 * 创建，拿不到 registry 的实例，这个槽位是两者唯一的交汇点。
 *
 * 未装配时 {@link getTicketsServerModule} 直接报错：静默退化会让所有工单端点以「仓库未绑定」响应，
 * 把装配故障伪装成业务结果。不为装配结果登记 cleanup：Facade / 领域服务 / 仓储都是无连接、无句柄的普通
 * 对象，进程退出不需要释放；{@link resetTicketsServerModule} 只服务测试，避免跨用例共享状态。
 */

let installed: TicketsServerModule | null = null;

/** 装入装配结果；由调度方（registry 工厂或测试）调用。 */
export function installTicketsServerModule(module: TicketsServerModule): void {
  installed = module;
}

/** 读取装配结果；未装配即报错，不做兜底实现。 */
export function getTicketsServerModule(): TicketsServerModule {
  if (!installed) {
    throw new Error("工单资源模块未装配：宿主启动流程必须先装配 git 与 access-control 模块");
  }
  return installed;
}

/** 清除装配结果，防止跨测试文件共享状态。 */
export function resetTicketsServerModule(): void {
  installed = null;
}
