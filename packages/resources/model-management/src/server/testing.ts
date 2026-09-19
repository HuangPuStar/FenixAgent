import type { AccessControlModule } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { providerResource } from "./access/provider-resource";
import type { ProviderFacadeApi } from "./facades/provider-facade";
import type { ModelManagementServerModule } from "./module";
import type { ModelRepository } from "./repositories/model-resource";
import type { ProviderRepository } from "./repositories/provider-resource";
import type { ProviderService } from "./services/provider-service";

/**
 * Provider / Model 资源包的测试替身。
 *
 * 只供测试使用：协议层测试需要"某个应用方法返回什么"这一最小控制面，不该为了构造它而装配真实授权
 * 实现、查询编译器与数据库。替身对未打桩的方法直接抛错——路由调用了用例未预期的方法时立即暴露，
 * 而不是静默返回 `undefined` 让断言失真。
 *
 * `identity` 默认取宿主注册的身份目录（测试进程由 `setup-mocks` 转发到 stub 注册表），而不是再复制
 * 一份 `IdentityDirectory` 替身：mcp / skill / agent-config 已各有一份等价实现，第五份只会让"哪个
 * 才是测试里的身份视图"更难回答。
 */

/** 未打桩的方法：调用即失败，`never` 返回值可赋给任意方法签名。 */
function unstubbed(name: string): () => never {
  return () => {
    throw new Error(`Provider 资源替身未打桩：${name}`);
  };
}

export function createStubProviderFacade(overrides: Partial<ProviderFacadeApi> = {}): ProviderFacadeApi {
  return {
    list: unstubbed("facade.list"),
    get: unstubbed("facade.get"),
    getById: unstubbed("facade.getById"),
    getForProbe: unstubbed("facade.getForProbe"),
    getWritable: unstubbed("facade.getWritable"),
    save: unstubbed("facade.save"),
    saveById: unstubbed("facade.saveById"),
    remove: unstubbed("facade.remove"),
    addModel: unstubbed("facade.addModel"),
    updateModel: unstubbed("facade.updateModel"),
    removeModel: unstubbed("facade.removeModel"),
    ...overrides,
  };
}

export function createStubProviderService(overrides: Partial<ProviderService> = {}): ProviderService {
  return {
    list: unstubbed("service.list"),
    findById: unstubbed("service.findById"),
    findByName: unstubbed("service.findByName"),
    findByResourceKey: unstubbed("service.findByResourceKey"),
    create: unstubbed("service.create"),
    update: unstubbed("service.update"),
    remove: unstubbed("service.remove"),
    findRowUnscoped: unstubbed("service.findRowUnscoped"),
    ...overrides,
  };
}

export function createStubModelRepository(overrides: Partial<ModelRepository> = {}): ModelRepository {
  return {
    listByProviderId: unstubbed("models.listByProviderId"),
    countByProviderIds: unstubbed("models.countByProviderIds"),
    findById: unstubbed("models.findById"),
    findByModelId: unstubbed("models.findByModelId"),
    upsert: unstubbed("models.upsert"),
    updateById: unstubbed("models.updateById"),
    updateByModelId: unstubbed("models.updateByModelId"),
    removeById: unstubbed("models.removeById"),
    removeByModelId: unstubbed("models.removeByModelId"),
    ...overrides,
  };
}

export function createStubProviderRepository(overrides: Partial<ProviderRepository> = {}): ProviderRepository {
  return {
    listReadable: unstubbed("repository.listReadable"),
    findReadableById: unstubbed("repository.findReadableById"),
    findReadableByKey: unstubbed("repository.findReadableByKey"),
    findReadableByName: unstubbed("repository.findReadableByName"),
    create: unstubbed("repository.create"),
    updateById: unstubbed("repository.updateById"),
    removeById: unstubbed("repository.removeById"),
    findByIdUnscoped: unstubbed("repository.findByIdUnscoped"),
    ...overrides,
  };
}

/** 授权能力替身：系统路径用例自行打桩；未打桩即失败，避免"默认放行"混进断言。 */
export function createStubAccessControl(overrides: Partial<AccessControlModule> = {}): AccessControlModule {
  return {
    id: "stub-access-control",
    resolveInitialScope: unstubbed("accessControl.resolveInitialScope"),
    initializeResourceAccess: unstubbed("accessControl.initializeResourceAccess"),
    authorize: unstubbed("accessControl.authorize"),
    createListConstraint: unstubbed("accessControl.createListConstraint"),
    resolveAccess: unstubbed("accessControl.resolveAccess"),
    resolveAccessMany: unstubbed("accessControl.resolveAccessMany"),
    ...overrides,
  };
}

/** 组装资源模块替身；未提供的部分使用默认替身，`resource` 始终是真实注册。 */
export function createStubModelManagementServerModule(
  overrides: Partial<ModelManagementServerModule> = {},
): ModelManagementServerModule {
  const service = overrides.service ?? createStubProviderService();
  return {
    resource: overrides.resource ?? providerResource,
    facade: overrides.facade ?? createStubProviderFacade(),
    service,
    models: overrides.models ?? createStubModelRepository(),
    accessControl: overrides.accessControl ?? createStubAccessControl(),
    repositories: overrides.repositories ?? { provider: createStubProviderRepository() },
    identity: overrides.identity ?? getIdentityDirectory(),
  };
}

export {
  getModelManagementModule,
  installModelManagementModule,
  resetModelManagementModule as resetModelManagementModuleForTesting,
} from "./module-runtime";
