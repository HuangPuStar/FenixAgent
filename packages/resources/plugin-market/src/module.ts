import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import {
  createPluginMarketServerModule,
  type PluginMarketModuleDeps,
  type PluginMarketServerModule,
} from "./server/module";
import { installPluginMarketModule } from "./server/runtime";

/**
 * 插件市场模块的 registry 装配入口（`fenix.module.ts` 的 `create` 目标）。
 *
 * 装配期做三件事：从 `context.modules` 取 access-control 的授权端口、从
 * `@fenix/platform-sdk/server` 取系统托管租户目录，然后调用 `./server/module` 的
 * `createPluginMarketServerModule` 构造实例并装入进程级槽位。真正的构造仍是那一处实现——本文件只补齐
 * 「依赖从哪来」，不复制任何组装逻辑（授权端口、身份目录与资源注册的绑定关系只允许有一处定义）。
 *
 * 必须 `install`：路由与系统路径都在调用时经 `getPluginMarketModule()` 读取同一份装配结果，registry
 * 装配完成后没有第二个写入方。不为它登记 cleanup：装配结果里只有无连接、无句柄的普通对象，进程退出
 * 不需要释放；`resetPluginMarketModule` 仍只服务测试。
 */
export function createPluginMarketModule(context: ModuleFactoryContext): PluginMarketServerModule {
  const module = createPluginMarketServerModule({
    ...requireAccessControlSuite(context),
    identity: getIdentityDirectory(),
  });
  installPluginMarketModule(module);
  return module;
}

/** 本包需要的授权端口子集；形状与 `PluginMarketModuleDeps` 的前三项一致。 */
type AccessControlSuite = Pick<PluginMarketModuleDeps, "accessControl" | "scopeStore" | "authorizedQuery">;

/**
 * 收窄 registry 注入的 access-control 实例。
 *
 * `context.modules` 的值是 `unknown`（registry 不解释模块实例的形状），本包不 import
 * `@fenix/access-control`（`resources → platform-impl` 被依赖矩阵禁止），因此这里按包内契约做一次
 * 显式收窄。端口缺失必须当场失败：静默退让会让所有市场端点以「资源不存在」响应，把装配故障伪装成
 * 业务结果。
 *
 * 为什么这段收窄在资源包里各写一份、而不抽到 `platform-sdk`：`context.modules` 的值是 `unknown`，
 * 收窄它需要「access-control 实例的形状」——该形状由 `@fenix/access-control` 定义，`platform-sdk`
 * 不得依赖 platform-impl；SDK 能提供的只有「按端口键取模块实例」的通用助手，那是一项新公共契约。
 * 各包按自己的 deps 类型（`Pick`）与失败文案对齐；提炼的触发条件是「出现第二个非 access-control 的
 * 端口也需要同形收窄」，届时按当时的形状评审这一项助手。
 */
function requireAccessControlSuite(context: ModuleFactoryContext): AccessControlSuite {
  const instance = context.modules.get("access-control") as Partial<AccessControlSuite> | undefined;
  if (!instance?.accessControl || !instance.scopeStore || !instance.authorizedQuery) {
    throw new Error("插件市场资源模块装配失败：access-control 模块未提供 accessControl / scopeStore / authorizedQuery");
  }
  return instance as AccessControlSuite;
}
