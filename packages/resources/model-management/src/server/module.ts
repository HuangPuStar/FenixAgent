import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { providerResource } from "./access/provider-resource";
import { ProviderFacade, type ProviderFacadeApi } from "./facades/provider-facade";
import { createModelRepository, type ModelRepository } from "./repositories/model-resource";
import {
  createProviderRepository,
  type ProviderQueryStorage,
  type ProviderRepository,
} from "./repositories/provider-resource";
import { createProviderService, type ProviderService } from "./services/provider-service";

/**
 * Provider / Model 资源包组合根。
 *
 * 依赖全部由注入方提供：授权能力来自 `@fenix/access-control`（`createDrizzleAccessControl` 的
 * `accessControl` / `scopeStore` / `authorizedQuery`），身份展示信息来自 `@fenix/identity` 的
 * `IdentityDirectory` 实现。本包不 import 任何具体实现，也不在模块内部保存进程级单例——一次装配
 * 产出一个实例集，测试可以装配自己的实例而互不影响。
 *
 * 本包只注册一个资源类型（`provider`）：Model 是它的子表，不注册独立资源（决策 D6），因此没有
 * 自己的查询存储类型，也不需要 `narrowAuthorizedQuery`。
 *
 * 注入方有两种，共用本函数这一处构造：registry 工厂（`src/module.ts` 的 `createModelManagementModule`，
 * 授权端口取自 `context.modules` 的 access-control 实例、身份目录取自 `@fenix/platform-sdk/server`）
 * 与测试（直接注入替身）。本函数只构造，不读 DB、不写单例，因此两条路径不会互相覆盖。
 */

export interface ModelManagementModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** access-control 汇总全部资源模块声明的绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 组织名录等展示信息的只读投影；不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface ModelManagementServerModule {
  /** 资源注册；manifest 经它声明 `accessControlBindings`，避免两处各写一份归属列。 */
  readonly resource: typeof providerResource;
  /** 协议层入口（授权 + 领域编排）。 */
  readonly facade: ProviderFacadeApi;
  /**
   * Provider 领域服务（无授权判断）。
   *
   * 只有系统路径可直接调用它（LaunchSpec 构建、模型网关 provider 同步）；对外路由必须走
   * `facade`，否则会绕过授权。
   */
  readonly service: ProviderService;
  /**
   * Model 子表的仓储。
   *
   * 与 Provider 一样只允许系统路径直接使用：用户请求路径一律经 `facade` 的子表方法，先对 Provider
   * 授权再落库。
   */
  readonly models: ModelRepository;
  /**
   * 平台授权能力。
   *
   * 对外暴露是给**系统路径**用的：模型网关的动作没有请求 actor，它需要为系统托管租户的主体构造
   * 自己的读取条件（`createListConstraint`）后才能走 `service` 的受控读取。用户请求路径不得从这里
   * 取授权能力，一律经 `facade`。
   */
  readonly accessControl: AccessControlModule;
  readonly repositories: { readonly provider: ProviderRepository };
  readonly identity: IdentityDirectory;
}

export function createModelManagementServerModule(deps: ModelManagementModuleDeps): ModelManagementServerModule {
  const providerRepository = createProviderRepository(
    narrowAuthorizedQuery<ProviderQueryStorage>(deps.authorizedQuery),
  );
  const service = createProviderService(providerRepository);
  const models = createModelRepository();
  return {
    resource: providerResource,
    facade: new ProviderFacade(
      { service, models },
      {
        accessControl: deps.accessControl,
        resource: providerResource.definition,
        scopeStore: deps.scopeStore,
      },
    ),
    service,
    models,
    accessControl: deps.accessControl,
    repositories: { provider: providerRepository },
    identity: deps.identity,
  };
}
