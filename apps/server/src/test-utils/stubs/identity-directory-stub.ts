// IdentityDirectory stub 注册表
//
// `IdentityDirectory` 是 `@fenix/platform-sdk` 的身份只读窄契约，生产由 `apps/server/src/main.ts`
// 在装配阶段经 `registerIdentityDirectory()` 注入（`packages/platform/identity` 提供实现）。
// 测试进程不装配宿主，因此 setup-mocks 注册一个转发到本注册表的代理实现，用例按需用
// `stubIdentityDirectory()` 逐字段覆盖。
//
// 默认值刻意取"空投影"而不是看似合理的假数据：未声明的身份数据应当让用例立即察觉缺失，而不是
// 读到编造出来的组织名或成员角色。`resolveSystemTenant` 默认抛错同理——系统托管租户的 `userId`
// 是审计主体，测试不得在未声明的情况下拿到一个假身份。

import type { IdentityDirectory } from "@fenix/platform-sdk";

const EMPTY_IDENTITY_DIRECTORY: IdentityDirectory = {
  listUserDisplayInfo: async () => new Map(),
  getUser: async () => undefined,
  findUserByName: async () => undefined,
  searchUsers: async () => [],
  listOrganizationNames: async () => new Map(),
  getOrganization: async () => undefined,
  resolveMembershipId: async () => undefined,
  listMemberships: async () => [],
  resolveSystemTenant: async () => {
    throw new Error("IdentityDirectory.resolveSystemTenant 未在测试中 stub");
  },
  listOrganizationsWithMembers: async () => [],
};

let _identityDirectoryStub: Partial<IdentityDirectory> = {};

export function stubIdentityDirectory(overrides: Partial<IdentityDirectory>) {
  _identityDirectoryStub = { ..._identityDirectoryStub, ...overrides };
}

/** 取当前生效的完整实现（默认值 + 用例覆盖），供转发代理按属性访问时读取。 */
export function getIdentityDirectoryStub(): IdentityDirectory {
  return { ...EMPTY_IDENTITY_DIRECTORY, ..._identityDirectoryStub };
}

export function resetIdentityDirectoryStub() {
  _identityDirectoryStub = {};
}
