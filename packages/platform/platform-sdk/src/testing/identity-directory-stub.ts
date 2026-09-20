/**
 * `IdentityDirectory` 替身注册表。
 *
 * `IdentityDirectory` 是平台契约的身份只读窄契约，生产由宿主装配阶段经 `registerIdentityDirectory()`
 * 注入（实现来自 `@fenix/identity`）。测试进程不装配宿主，因此由 preload 注册一个转发到本注册表的
 * 代理实现，用例按需用 `stubIdentityDirectory()` 逐字段覆盖。
 *
 * 默认值刻意取「空投影」而不是看似合理的假数据：未声明的身份数据应当让用例立即察觉缺失，而不是读到
 * 编造出来的组织名或成员角色。`resolveSystemTenant` 默认抛错同理——系统托管租户的 `userId` 是审计
 * 主体，测试不得在未声明的情况下拿到一个假身份。
 */

import type { IdentityDirectory } from "../identity/identity-directory";
import { registerIdentityDirectory } from "../server";

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

let identityDirectoryStub: Partial<IdentityDirectory> = {};

/** 覆盖身份目录的单个方法；未覆盖字段保留空投影默认值。 */
export function stubIdentityDirectory(overrides: Partial<IdentityDirectory>): void {
  identityDirectoryStub = { ...identityDirectoryStub, ...overrides };
}

/** 取当前生效的完整实现（默认值 + 用例覆盖），供转发代理按属性访问时读取。 */
export function getIdentityDirectoryStub(): IdentityDirectory {
  return { ...EMPTY_IDENTITY_DIRECTORY, ...identityDirectoryStub };
}

/**
 * 把身份目录契约接到本注册表（宿主 preload 在测试进程启动时调用一次）。
 *
 * 注册的是转发代理而不是快照：用例在任意时刻 `stubIdentityDirectory()` 都能立即生效，不需要重新注册。
 * 生产用 `registerIdentityDirectory()` 的严格语义（重复注册抛错）不受影响——测试进程只装配一次。
 */
export function registerTestIdentityDirectory(): void {
  registerIdentityDirectory(
    new Proxy({} as IdentityDirectory, {
      get: (_target, prop) => getIdentityDirectoryStub()[prop as keyof IdentityDirectory],
    }),
  );
}

/** 清空用例覆盖，供用例之间复位。 */
export function resetIdentityDirectoryStub(): void {
  identityDirectoryStub = {};
}
