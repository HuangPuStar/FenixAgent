import type { IdentityDirectory } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { skillResource } from "./access/skill-resource";
import type { SkillModuleConfig } from "./config";
import type { SkillFacadeApi } from "./facades/skill-facade";
import type { SkillServerModule } from "./module";
import type { SkillService } from "./services/skill-service";
import type { SkillSystemApi } from "./services/skill-system";

/**
 * Skill 资源包的测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 两部分：领域替身（协议层用例的最小控制面）与模块配置构造。配置构造放在这里，是为了让宿主测试
 * （`apps/server/src/test-utils/setup-mocks.ts`）与本包用例共用同一份「必填字段 + 缺省值」：宿主手抄
 * 一份字段清单、包内再抄一份，漏字段时两侧都不可见。
 */

/**
 * 构造一份字段齐全的 Skill 模块配置。
 *
 * 缺省值取宿主 `apps/server/src/config.ts` 的部署默认值：`SKILL_DIR` 缺省 `./data/skills`
 * （`resolve()` 之前的取值）、`RCS_BASE_URL` 未设置时回退 `http://localhost:<RCS_PORT 默认 3000>`。
 * 签名密钥缺省为空列表＝"未配置签名密钥"，与宿主 `RCS_API_KEYS` 未设置时的结论一致（下载 token
 * 生成失败，而不是退化成无签名）。需要签名的用例显式传入测试密钥，且只在运行期生成，不落源码。
 *
 * `skillDir` 缺省是相对路径：需要真实读写内容的用例必须传自己的临时目录，避免往运行目录写数据。
 */
export function createSkillModuleConfig(overrides: Partial<SkillModuleConfig> = {}): SkillModuleConfig {
  return {
    skillDir: "./data/skills",
    baseUrl: "http://localhost:3000",
    downloadTokenSigningKeys: [],
    ...overrides,
  };
}

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须经 `initializeTestApplicationInfrastructure` 走生产读取路径（`getModuleConfig("skill")`），
 * 而不是给模块留测试专用的配置分支；初始化只允许一次，故先复位。
 */
export function initializeSkillModuleConfig(overrides: Partial<SkillModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    moduleConfigs: { skill: createSkillModuleConfig(overrides) },
  });
}

/** 未打桩的方法：调用即失败，`never` 返回值可赋给任意方法签名。 */
function unstubbed(name: string): () => never {
  return () => {
    throw new Error(`Skill 资源替身未打桩：${name}`);
  };
}

export function createStubSkillFacade(overrides: Partial<SkillFacadeApi> = {}): SkillFacadeApi {
  return {
    list: unstubbed("facade.list"),
    get: unstubbed("facade.get"),
    getById: unstubbed("facade.getById"),
    readDetail: unstubbed("facade.readDetail"),
    readDetailById: unstubbed("facade.readDetailById"),
    create: unstubbed("facade.create"),
    update: unstubbed("facade.update"),
    setPublicReadable: unstubbed("facade.setPublicReadable"),
    remove: unstubbed("facade.remove"),
    removeById: unstubbed("facade.removeById"),
    importDirectories: unstubbed("facade.importDirectories"),
    ...overrides,
  };
}

export function createStubSkillService(overrides: Partial<SkillService> = {}): SkillService {
  return {
    list: unstubbed("service.list"),
    findById: unstubbed("service.findById"),
    findByName: unstubbed("service.findByName"),
    listByNames: unstubbed("service.listByNames"),
    findByResourceKey: unstubbed("service.findByResourceKey"),
    create: unstubbed("service.create"),
    upsertByOrgAndName: unstubbed("service.upsertByOrgAndName"),
    update: unstubbed("service.update"),
    remove: unstubbed("service.remove"),
    removeByName: unstubbed("service.removeByName"),
    findRowUnscoped: unstubbed("service.findRowUnscoped"),
    listByOrganizationUnscoped: unstubbed("service.listByOrganizationUnscoped"),
    findByNameUnscoped: unstubbed("service.findByNameUnscoped"),
    setVisibilityUnscoped: unstubbed("service.setVisibilityUnscoped"),
    ...overrides,
  };
}

export function createStubSkillSystem(overrides: Partial<SkillSystemApi> = {}): SkillSystemApi {
  return {
    listByOrganization: unstubbed("system.listByOrganization"),
    findByName: unstubbed("system.findByName"),
    findById: unstubbed("system.findById"),
    writeDocument: unstubbed("system.writeDocument"),
    removeByName: unstubbed("system.removeByName"),
    setPublicReadable: unstubbed("system.setPublicReadable"),
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
export function createStubSkillServerModule(overrides: Partial<SkillServerModule> = {}): SkillServerModule {
  return {
    resource: overrides.resource ?? skillResource,
    facade: overrides.facade ?? createStubSkillFacade(),
    service: overrides.service ?? createStubSkillService(),
    system: overrides.system ?? createStubSkillSystem(),
    identity: overrides.identity ?? createStubIdentityDirectory(),
  };
}

export {
  getSkillServerModule,
  installSkillServerModule,
  resetSkillServerModule as resetSkillServerModuleForTesting,
} from "./runtime";
