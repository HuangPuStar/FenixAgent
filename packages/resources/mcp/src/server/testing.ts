import type { IdentityDirectory } from "@fenix/platform-sdk";
import { mcpServerResource } from "./access/mcp-server-resource";
import type { McpServerFacadeApi } from "./facades/mcp-server-facade";
import type { McpServerServerModule } from "./module";
import type { McpServerService } from "./services/mcp-server-service";

/**
 * MCP 资源包的测试替身。
 *
 * 只供测试使用：协议层测试需要"某个应用方法返回什么"这一最小控制面，不应该为了构造它而装配真实
 * 授权实现、查询编译器与数据库。替身默认对未打桩的方法直接抛错——路由调用了用例未预期的方法时
 * 立即暴露，而不是静默返回 undefined 让断言失真。
 */

/** 未打桩的方法：调用即失败，`never` 返回值可赋给任意方法签名。 */
function unstubbed(name: string): () => never {
  return () => {
    throw new Error(`MCP 资源替身未打桩：${name}`);
  };
}

export function createStubMcpFacade(overrides: Partial<McpServerFacadeApi> = {}): McpServerFacadeApi {
  return {
    list: unstubbed("facade.list"),
    get: unstubbed("facade.get"),
    getById: unstubbed("facade.getById"),
    getWritable: unstubbed("facade.getWritable"),
    getWritableById: unstubbed("facade.getWritableById"),
    create: unstubbed("facade.create"),
    update: unstubbed("facade.update"),
    updateById: unstubbed("facade.updateById"),
    remove: unstubbed("facade.remove"),
    removeById: unstubbed("facade.removeById"),
    setEnabled: unstubbed("facade.setEnabled"),
    listTools: unstubbed("facade.listTools"),
    saveInspectedTools: unstubbed("facade.saveInspectedTools"),
    ...overrides,
  };
}

export function createStubMcpServerService(overrides: Partial<McpServerService> = {}): McpServerService {
  return {
    list: unstubbed("service.list"),
    findById: unstubbed("service.findById"),
    findByName: unstubbed("service.findByName"),
    findByResourceKey: unstubbed("service.findByResourceKey"),
    create: unstubbed("service.create"),
    upsertSystemServer: unstubbed("service.upsertSystemServer"),
    update: unstubbed("service.update"),
    setEnabled: unstubbed("service.setEnabled"),
    remove: unstubbed("service.remove"),
    countTools: unstubbed("service.countTools"),
    listTools: unstubbed("service.listTools"),
    replaceTools: unstubbed("service.replaceTools"),
    ...overrides,
  };
}

/**
 * 身份目录替身。
 *
 * 默认只有组织名录返回空表（视图因此省略 `sourceOrganizationName`，与名录不可用时的既有行为一致），
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
export function createStubMcpServerModule(overrides: Partial<McpServerServerModule> = {}): McpServerServerModule {
  return {
    resource: overrides.resource ?? mcpServerResource,
    facade: overrides.facade ?? createStubMcpFacade(),
    service: overrides.service ?? createStubMcpServerService(),
    identity: overrides.identity ?? createStubIdentityDirectory(),
  };
}

export {
  getMcpServerModule,
  installMcpServerModule,
  resetMcpServerModule as resetMcpServerModuleForTesting,
} from "./runtime";
