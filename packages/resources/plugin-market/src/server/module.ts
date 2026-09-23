import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { pluginPackageResource } from "./access/plugin-package-resource";
import type { PluginPackageFacadeApi } from "./facades/plugin-package-facade";
import { PluginPackageFacade } from "./facades/plugin-package-facade";
import { createPluginPackageReadRepository, type PluginPackageQueryStorage } from "./repositories/plugin-package-read";
import { createPluginPackageService } from "./services/plugin-package-service";

/**
 * 插件市场资源包组合根。
 *
 * 依赖全部由注入方提供：授权能力来自 `@fenix/access-control`（`accessControl` / `scopeStore` /
 * `authorizedQuery`），系统托管租户信息来自 `@fenix/platform-sdk` 的 `IdentityDirectory` 窄契约。本包不
 * import 任何具体实现，也不在模块内部保存进程级单例——一次装配产出一个实例集，测试可以装配自己的实例而
 * 互不影响。
 *
 * 注入方有两种，共用本函数这一处构造：registry 工厂（`src/module.ts` 的 `createPluginMarketModule`，授权
 * 端口取自 `context.modules` 的 access-control 实例、身份目录取自 `@fenix/platform-sdk/server`）与测试
 * （直接注入替身）。本函数只构造，不读 DB、不写单例，因此两条路径不会互相覆盖。
 *
 * 为什么需要身份目录（对比：市场没有一处跨模块的展示投影）：市场条目是**平台全局目录**，归属组织必须
 * 固定为系统托管租户——`resolveInitialScope` 的 `organizationId` 参数只应由系统管理路径显式传入，
 * 否则实际平台管理员的 active organization 会泄漏成归属组织，同一份全局目录会被切散到多个组织下。
 * 这条解析走的是只读窄契约（`resolveSystemTenant()`），与 `@fenix/resource-mcp` 同一口径。
 *
 * 装配结果**只暴露 Facade**，不暴露 Domain Service：市场没有「系统初始化路径」（对比 MCP 的 Hindsight
 * 托管服务器写入），任何写入口都必须经过授权编排，因此不需要给绕开 Facade 的调用方留一条通道。
 */

export interface PluginMarketModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** access-control 汇总全部资源模块声明的绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 系统托管租户的只读投影；归属组织与系统主体由它解析，不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface PluginMarketServerModule {
  /** 资源注册；manifest 经它声明 `accessControlBindings`，避免两处各写一份归属列。 */
  readonly resource: typeof pluginPackageResource;
  /** 唯一应用入口（授权 + 发布状态分派 + 私有源编排）；`/web/config/plugin-market/*` 只经它读写。 */
  readonly facade: PluginPackageFacadeApi;
}

export function createPluginMarketServerModule(deps: PluginMarketModuleDeps): PluginMarketServerModule {
  const query = narrowAuthorizedQuery<PluginPackageQueryStorage>(deps.authorizedQuery);
  const service = createPluginPackageService(createPluginPackageReadRepository(query));
  return {
    resource: pluginPackageResource,
    facade: new PluginPackageFacade(service, {
      accessControl: deps.accessControl,
      resource: pluginPackageResource.definition,
      scopeStore: deps.scopeStore,
      identity: deps.identity,
    }),
  };
}
