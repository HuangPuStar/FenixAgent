import type { IdentityDirectory } from "@fenix/platform-sdk";
import { skillResource } from "./access/skill-resource";
import type { SkillFacadeApi } from "./facades/skill-facade";
import type { SkillServerModule } from "./module";
import type { SkillService } from "./services/skill-service";
import type { SkillSystemApi } from "./services/skill-system";

/**
 * Skill 资源包的测试替身。
 *
 * 只供测试使用：协议层测试需要"某个应用方法返回什么"这一最小控制面，不应该为了构造它而装配真实
 * 授权实现、查询编译器、文件系统与数据库。替身默认对未打桩的方法直接抛错——路由调用了用例未预期
 * 的方法时立即暴露，而不是静默返回 undefined 让断言失真。
 */

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
