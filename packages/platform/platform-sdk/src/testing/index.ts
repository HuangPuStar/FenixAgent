/**
 * `@fenix/platform-sdk/testing`：平台契约的测试替身与通用测试基建。
 *
 * 为什么必须在契约包里：宿主的测试 preload（`apps/server/src/test-utils/setup-mocks.ts`）与各包
 * 的用例必须共用**同一个**替身注册表实例——preload 注册的是转发代理，用例写入的是注册表；两处各持
 * 一份实现会让 `stubXxx()` 静默失效（测试照常运行，但读到的是未声明的默认值）。而
 * `@server/test-utils/*` 是宿主内部路径，包不得依赖。
 *
 * 收纳边界（其余替身不进本子路径）：
 * - **平台契约**的替身放这里：`getDatabase()`（DB 句柄）、`getModuleConfig()`（模块配置）、
 *   `getIdentityDirectory()`（身份目录窄契约）、身份认证入口（`auth.api` / handler）。
 * - 各包自身模块的替身放该包的 `/server/testing`（参见 `packages/resources/machine/src/server/testing.ts`）。
 * - 宿主自身模块的替身留在 `apps/server/src/test-utils/`（`stubConfigPg`、`stubSystemApi` 等）。
 *
 * 生命周期约定：用例在 `beforeEach` 调用 {@link resetAllStubs} 复位全部替身，再显式声明本用例需要的
 * 部分；替身状态是进程级的，不复位会让上一条用例的配置泄漏到下一条。
 */

export * from "./auth-stub";
export * from "./db-stub";
export * from "./identity-directory-stub";
export * from "./module-config-stub";
export * from "./reset-all-stubs";
export * from "./response";
export * from "./stub-registry";
export * from "./test-application-infrastructure";
