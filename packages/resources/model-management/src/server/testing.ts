import type { AccessControlModule } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { providerResource } from "./access/provider-resource";
import type { ModelManagementModuleConfig } from "./config";
import type { ProviderFacadeApi } from "./facades/provider-facade";
import type { ModelManagementServerModule } from "./module";
import type { ModelRepository } from "./repositories/model-resource";
import type { ProviderRepository } from "./repositories/provider-resource";
import type { ProviderService } from "./services/provider-service";

/**
 * Provider / Model 资源包的测试替身与模块配置夹具。
 *
 * 只供测试使用：协议层测试需要"某个应用方法返回什么"这一最小控制面，不该为了构造它而装配真实授权
 * 实现、查询编译器与数据库。替身对未打桩的方法直接抛错——路由调用了用例未预期的方法时立即暴露，
 * 而不是静默返回 `undefined` 让断言失真。
 *
 * `identity` 默认取宿主注册的身份目录（测试进程由 `setup-mocks` 转发到 stub 注册表），而不是再复制
 * 一份 `IdentityDirectory` 替身：mcp / skill / agent-config 已各有一份等价实现，第五份只会让"哪个
 * 才是测试里的身份视图"更难回答。
 *
 * 配置夹具（{@link createModelManagementModuleConfig}）与沙盒样本同形，目标形态是宿主 `setup-mocks` 与
 * 包内用例共用同一份「必填字段 + 部署默认值」；今天宿主尚未接入（实测 `apps/server/src/test-utils/
 * setup-mocks.ts` 未登记 `model-management`，也无人 import 本夹具），接入属宿主侧 patch，见 README
 * 「边界残留」。在此之前的消费方只有包内用例。
 */

/**
 * 构造一份字段齐全的模型管理模块配置。
 *
 * 缺省值取宿主部署默认（`apps/server/src/config.ts`：`RCS_MODEL_GATEWAY_TYPE` 默认 `litellm`、
 * `RCS_MODEL_GATEWAY_BASE_URL` / `RCS_MODEL_GATEWAY_ADMIN_UI_URL` 默认本地端点；公开地址缺省回落到
 * 内部地址）。**默认不带任何密钥**：管理凭证与凭据加密密钥缺失时网关运行时返回 `null`，与"未配置网关"
 * 的生产默认一致；需要网关启用路径的用例显式传入这两个字段，且只能用测试常量，不得写入真实密钥。
 */
export function createModelManagementModuleConfig(
  overrides: Partial<ModelManagementModuleConfig> = {},
): ModelManagementModuleConfig {
  return {
    modelGatewayType: "litellm",
    modelGatewayBaseUrl: "http://localhost:4000",
    modelGatewayPublicBaseUrl: "http://localhost:4000",
    modelGatewayAdminUiUrl: "http://localhost:4000/ui/",
    ...overrides,
  };
}

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须经 `initializeTestApplicationInfrastructure` 走生产读取路径（`getModuleConfig("model-management")`
 * + 包内 schema 校验），而不是给模块留测试专用的配置分支；初始化只允许一次，故先复位。
 */
export function initializeModelManagementModuleConfig(overrides: Partial<ModelManagementModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    moduleConfigs: { "model-management": createModelManagementModuleConfig(overrides) },
  });
}

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
    findRowUnscoped: unstubbed("models.findRowUnscoped"),
    findFirstByProviderUnscoped: unstubbed("models.findFirstByProviderUnscoped"),
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
    findRowByOrganizationUnscoped: unstubbed("repository.findRowByOrganizationUnscoped"),
    listByOrganizationUnscoped: unstubbed("repository.listByOrganizationUnscoped"),
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
