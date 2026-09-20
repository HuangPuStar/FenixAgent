import { resetApplicationInfrastructure } from "../server";
import { resetAuthStubs } from "./auth-stub";
import { resetDbStub } from "./db-stub";
import { resetIdentityDirectoryStub } from "./identity-directory-stub";
import { resetModuleConfigStubs } from "./module-config-stub";

/**
 * 额外复位器的登记表。
 *
 * 为什么需要登记表：一次用例运行会同时用到多层替身——平台契约的替身（DB、模块配置、身份目录、认证入口）
 * 在本子路径，宿主模块的替身在 `apps/server/src/test-utils/stubs/*`，资源包自身模块的替身在各包的
 * `/server/testing`。用例在 `beforeEach` 里只能调用一个复位入口，否则漏掉哪一层，那一层的用例级配置就
 * 会泄漏到下一条用例；而泄漏的症状是「单独跑通过、全量跑失败」，失败点与泄漏源相隔很远。
 *
 * 平台契约不能反向 import 宿主或资源包的替身实现（会让契约包依赖具体实现），因此改为由持有者在自己被加载
 * 时登记复位函数：宿主 preload（`apps/server/src/test-utils/setup-mocks.ts`）在进程启动时登记宿主模块的
 * 复位器，包的 `/server/testing` 在被用例 import 时登记本包的复位器。
 */
const stubResetters: Array<() => void> = [];

/**
 * 登记一个复位器，随 {@link resetAllStubs} 一起执行。
 *
 * 登记是进程级、只增不减的：同一实现重复登记会重复执行（复位幂等，重复执行的代价只是一次多余调用），
 * 因此本函数不做去重——去重需要实现提供身份，会把简单契约复杂化。
 */
export function registerStubResetter(reset: () => void): void {
  stubResetters.push(reset);
}

/**
 * 复位本子路径登记的全部替身：DB、模块配置覆盖、身份目录覆盖、认证入口，已初始化的应用基础设施，
 * 以及经 {@link registerStubResetter} 登记的宿主/资源包模块替身。
 *
 * 用例在 `beforeEach` 调用它，再显式声明本用例需要的那部分——与宿主「启动期一次性装配」对应。替身状态
 * 是进程级的，不复位会让上一条用例的 DB 对象、会话或组织成员关系泄漏到下一条，而这类泄漏通常表现为
 * 「单独跑通过、全量跑失败」。
 *
 * 复位应用基础设施是刻意的：初始化本身只允许一次，若复位不包含它，第二条用例再初始化就会抛错。
 * 模块配置的**基线**（preload 期登记的生产默认值）不在复位范围内，见 `module-config-stub.ts`。
 */
export function resetAllStubs(): void {
  resetDbStub();
  resetModuleConfigStubs();
  resetIdentityDirectoryStub();
  resetAuthStubs();
  resetApplicationInfrastructure();
  for (const reset of stubResetters) {
    reset();
  }
}
