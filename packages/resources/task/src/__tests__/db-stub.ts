import { getDbStub, initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";

/**
 * 仓储测试的 DB 替身装配。
 *
 * 仓储改为在调用时取句柄（`getTaskDatabase()` → `getDatabase()`）后，替身必须经
 * `initializeTestApplicationInfrastructure()` 注入才可见——宿主 preload 的 `mock.module("@server/db")`
 * 转发代理只覆盖旧的模块级 `db` 导出，不再经过这条路径。
 *
 * 为什么注入的是**代理**而不是当次替身：基础设施持有的是引用，用例中途再 `stubDb()` 换替身不会改变
 * 已注入句柄（见 `@fenix/platform-sdk/testing` 的说明）。代理每次取属性都转发到当前替身，
 * 于是「`beforeEach` 初始化一次 + 用例内随时 `stubDb(...)`」与旧的模块级 `db` 语义一致，
 * 用例无需为换替身重建基础设施。
 */

// biome-ignore lint/suspicious/noExplicitAny: 替身形状随用例变化（链式查询构建器），读取方自行收窄
const forwardingDb = new Proxy({} as Record<string, any>, {
  get: (_target, prop) => getDbStub()[prop as string],
});

/** 复位全部替身并以转发代理初始化应用基础设施；随后用例可反复 `stubDb(...)` 更换替身。 */
export function resetStubsWithDb(): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: forwardingDb });
}
