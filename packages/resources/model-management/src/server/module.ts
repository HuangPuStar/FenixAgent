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
 * 依赖全部由宿主注入：授权能力来自 `@fenix/access-control`（`createDrizzleAccessControl` 的
 * `accessControl` / `scopeStore` / `authorizedQuery`），身份展示信息来自 `@fenix/identity` 的
 * `IdentityDirectory` 实现。本包不 import 任何具体实现，也不在模块内部保存进程级单例——一次装配
 * 产出一个实例集，测试可以装配自己的实例而互不影响。
 *
 * 本包只注册一个资源类型（`provider`）：Model 是它的子表，不注册独立资源（决策 D6），因此没有
 * 自己的查询存储类型，也不需要 `narrowAuthorizedQuery`。
 *
 * 已知不足：当前由 `apps/server` 启动流程手工注入，模块注册表尚未表达"平台能力 + 身份目录"这类
 * 构造依赖；registry 驱动的组合根落地时，本函数即模块工厂的目标形状（见
 * `packages/platform/access-control/fenix.module.ts` 的同类说明）。
 */

export interface ModelManagementModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 宿主汇总全部资源绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 组织名录等展示信息的只读投影；不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface ModelManagementServerModule {
  /** 资源注册；宿主汇总 `bindings` 时使用，避免两处各写一份归属列。 */
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
