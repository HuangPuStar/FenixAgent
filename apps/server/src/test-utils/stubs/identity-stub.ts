// identity 模块配置 stub 注册表
//
// `@fenix/identity` 是纯库：DB 与部署配置都经 `@fenix/platform-sdk/server` 读取，生产由宿主
// `apps/server/src/main.ts` 的 `initializeApplicationInfrastructure()` 提供。测试进程不能初始化
// 应用基础设施——`platform-sdk` 的 `server-infrastructure.test.ts` 依赖"未初始化时读取必须失败"
// 这一前提——因此 setup-mocks 把 identity 的配置入口接到本注册表。
//
// 默认值与 `apps/server/src/env.ts` 的对应变量保持一致：未在本用例中显式 stub 的测试拿到的应当
// 是"生产默认配置"，而不是空对象。

import type { IdentityConfig } from "@fenix/identity/server";

const DEFAULT_IDENTITY_CONFIG: IdentityConfig = {
  betterAuthUrl: undefined,
  rcsBaseUrl: undefined,
  trustedOrigins: undefined,
  systemAdminPasswordFile: "./data/password.txt",
  disableSignup: false,
};

let _identityConfig: IdentityConfig = DEFAULT_IDENTITY_CONFIG;

/** 覆盖 identity 模块配置的字段，未覆盖字段保留默认值。 */
export function stubIdentityConfig(overrides: Partial<IdentityConfig>) {
  _identityConfig = { ...DEFAULT_IDENTITY_CONFIG, ...overrides };
}

export function getIdentityConfigStub(): IdentityConfig {
  return _identityConfig;
}

export function resetIdentityConfigStub() {
  _identityConfig = DEFAULT_IDENTITY_CONFIG;
}
