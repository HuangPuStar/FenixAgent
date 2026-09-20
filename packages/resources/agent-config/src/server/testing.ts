import type { IdentityDirectory } from "@fenix/platform-sdk";
import { getDbStub, initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { agentConfigResource } from "./access/agent-config-resource";
import type { AgentConfigModuleConfig } from "./config";
import type { AgentConfigFacadeApi } from "./facades/agent-config-facade";
import type { AgentConfigServerModule } from "./module";
import type { AgentAssociations } from "./services/agent-associations";
import type { AgentConfigService } from "./services/agent-config-service";

/**
 * AgentConfig 资源包的测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 只供测试使用：协议层测试需要"某个应用方法返回什么"这一最小控制面，不应该为了构造它而装配真实
 * 授权实现、查询编译器与数据库。替身默认对未打桩的方法直接抛错——路由调用了用例未预期的方法时
 * 立即暴露，而不是静默返回 undefined 让断言失真。
 */

/**
 * 构造一份字段齐全的 agent-config 模块配置。
 *
 * 缺省值取宿主 env 的缺省：`APP_HIDDEN_SIDEBAR_TABS` 未设置即空串（不隐藏任何 tab）。宿主测试
 * （`apps/server/src/test-utils/setup-mocks.ts`）与本包用例共用这一份「必填字段 + 缺省值」，避免宿主
 * 手抄一份字段清单、包内再抄一份，漏字段时两侧都不可见。
 */
export function createAgentConfigModuleConfig(
  overrides: Partial<AgentConfigModuleConfig> = {},
): AgentConfigModuleConfig {
  return {
    hiddenSidebarTabs: "",
    ...overrides,
  };
}

/**
 * DB 句柄替身的转发代理。
 *
 * 本包仓储与路由在调用时取句柄（`getAgentConfigDatabase()` → `getDatabase()`），句柄由应用基础设施持有；
 * 而用例在 `beforeEach` 之后才登记本用例的 DB 替身（`stubDb()`）。基础设施持有的是初始化那一刻的对象
 * **引用**，直接传当次替身会让后续每次 `stubDb()` 都不生效，症状是「从第二条用例起读到上一条的 db」。
 * 因此传代理，按每次属性访问转发到当前替身——与宿主 preload 的 `createDbMock`、machine/knowledge/sandbox
 * 的同名代理同形，各处指向同一个 `getDbStub()`。
 *
 * 为什么需要它：迁移前仓储读 `@server/db` 的模块级 `db` 导出，宿主 preload 用转发代理 mock 了它；改为读
 * 平台契约的 `getDatabase()` 后，那条 mock 不再经过，只有注入才可见。
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle 句柄形状随用例变化，读取方（仓储/路由）自行收窄
const agentConfigDbProxy = new Proxy({} as Record<string, any>, {
  get: (_target, prop) => getDbStub()[prop as string],
});

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须经 `initializeTestApplicationInfrastructure` 走生产读取路径（`getModuleConfig("agent-config")`），
 * 而不是给模块留测试专用的配置分支；初始化只允许一次，故先复位。
 */
export function initializeAgentConfigModuleConfig(overrides: Partial<AgentConfigModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: agentConfigDbProxy,
    moduleConfigs: { "agent-config": createAgentConfigModuleConfig(overrides) },
  });
}

/** 未打桩的方法：调用即失败，`never` 返回值可赋给任意方法签名。 */
function unstubbed(name: string): () => never {
  return () => {
    throw new Error(`AgentConfig 资源替身未打桩：${name}`);
  };
}

export function createStubAgentConfigFacade(overrides: Partial<AgentConfigFacadeApi> = {}): AgentConfigFacadeApi {
  return {
    list: unstubbed("facade.list"),
    get: unstubbed("facade.get"),
    getById: unstubbed("facade.getById"),
    existsInOrganization: unstubbed("facade.existsInOrganization"),
    create: unstubbed("facade.create"),
    update: unstubbed("facade.update"),
    remove: unstubbed("facade.remove"),
    restartInstances: unstubbed("facade.restartInstances"),
    ...overrides,
  };
}

export function createStubAgentConfigService(overrides: Partial<AgentConfigService> = {}): AgentConfigService {
  return {
    list: unstubbed("service.list"),
    findById: unstubbed("service.findById"),
    findByName: unstubbed("service.findByName"),
    findByResourceKey: unstubbed("service.findByResourceKey"),
    create: unstubbed("service.create"),
    update: unstubbed("service.update"),
    remove: unstubbed("service.remove"),
    listBoundEnvironmentIds: unstubbed("service.listBoundEnvironmentIds"),
    findRowUnscoped: unstubbed("service.findRowUnscoped"),
    findByNameUnscoped: unstubbed("service.findByNameUnscoped"),
    ...overrides,
  };
}

/**
 * 关联资源绑定替身。
 *
 * 默认让"读绑定"返回空集合（列表/详情因此渲染成空关联，不会因为未打桩而整体报错），写入方法未打桩
 * 即失败——写入用例必须显式声明它期望的绑定集合。
 */
export function createStubAgentAssociations(overrides: Partial<AgentAssociations> = {}): AgentAssociations {
  return {
    listSkillIds: async () => [],
    syncSkills: unstubbed("associations.syncSkills"),
    listMcpIds: async () => [],
    syncMcps: unstubbed("associations.syncMcps"),
    listSiteAppIds: async () => [],
    syncSiteApps: unstubbed("associations.syncSiteApps"),
    listKnowledgeBindings: async () => [],
    getKnowledge: async () => null,
    syncKnowledge: unstubbed("associations.syncKnowledge"),
    isMemoryEnabled: async () => false,
    setMemoryEnabled: unstubbed("associations.setMemoryEnabled"),
    ...overrides,
  };
}

/**
 * 身份目录替身。
 *
 * 默认只有组织名录返回空表（视图因此省略 `organizationName`，与名录不可用时的既有行为一致），
 * 其余方法未打桩即失败。
 */
export function createStubIdentityDirectory(overrides: Partial<IdentityDirectory> = {}): IdentityDirectory {
  const unstubbedMethods: Record<keyof IdentityDirectory, () => never> = {
    listUserDisplayInfo: unstubbed("identity.listUserDisplayInfo"),
    getUser: unstubbed("identity.getUser"),
    findUserByName: unstubbed("identity.findUserByName"),
    searchUsers: unstubbed("identity.searchUsers"),
    listOrganizationNames: unstubbed("identity.listOrganizationNames"),
    getOrganization: unstubbed("identity.getOrganization"),
    resolveMembershipId: unstubbed("identity.resolveMembershipId"),
    listMemberships: unstubbed("identity.listMemberships"),
    resolveSystemTenant: unstubbed("identity.resolveSystemTenant"),
    listOrganizationsWithMembers: unstubbed("identity.listOrganizationsWithMembers"),
  };
  return {
    ...unstubbedMethods,
    listOrganizationNames: async () => new Map<string, string>(),
    ...overrides,
  };
}

/**
 * 组装资源模块替身；未提供的部分使用默认替身，`resource` 始终是真实注册。
 *
 * 逐字段兜底而不是 `...overrides` 收尾：显式传入的 `undefined` 也会出现在展开结果里，把兜底值
 * 覆盖回 `undefined`。
 */
export function createStubAgentConfigServerModule(
  overrides: Partial<AgentConfigServerModule> = {},
): AgentConfigServerModule {
  return {
    resource: overrides.resource ?? agentConfigResource,
    facade: overrides.facade ?? createStubAgentConfigFacade(),
    service: overrides.service ?? createStubAgentConfigService(),
    associations: overrides.associations ?? createStubAgentAssociations(),
    identity: overrides.identity ?? createStubIdentityDirectory(),
  };
}

export {
  getAgentConfigModule,
  installAgentConfigModule,
  resetAgentConfigModule as resetAgentConfigModuleForTesting,
} from "./runtime";
