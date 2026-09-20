/**
 * 测试用的应用基础设施初始化辅助。
 *
 * 生产由宿主 `main.ts` 在装配阶段调用一次 `initializeApplicationInfrastructure()`；包内代码经
 * `getDatabase()` / `getModuleConfig()` 读取。包内用例要覆盖 repository / facade 时，必须让这两个读取
 * 返回替身——本函数是那条路径的唯一入口。
 *
 * 严格性与 `initializeApplicationInfrastructure` 完全一致（同步、只允许一次、重复调用抛错），刻意不做
 * 「last write wins」的宽松版本：初始化两次意味着两个 DB 句柄或两套配置在进程内共存，测试应当看到与
 * 生产同样的失败，而不是在用例之间静默共享状态。用例之间复位走 {@link resetAllStubs}。
 *
 * 与 {@link getDbStub} 的关系：`database` 缺省取当前 DB 替身，避免用例把同一个替身登记两遍而两处漂移。
 * 注意基础设施持有的是**引用**：`initializeTestApplicationInfrastructure()` 之后再次 `stubDb()` 不会
 * 改变已注入的句柄，需要换替身时先在 `beforeEach` 复位再初始化。
 */

import { initializeApplicationInfrastructure } from "../server";
import { getDbStub } from "./db-stub";

/** 初始化输入：`database` 缺省取 DB 替身，`moduleConfigs` 缺省为空（模块读取时按 `getModuleConfig()` 语义抛错）。 */
export interface InitializeTestApplicationInfrastructureInput {
  /** 进程级 DB 句柄替身；缺省为 {@link getDbStub} 当前持有的对象。 */
  readonly database?: unknown;
  /** 已校验的只读模块配置，按模块 ID 拆分；缺省为空。 */
  readonly moduleConfigs?: Readonly<Record<string, unknown>>;
}

/** 以替身完成应用基础设施初始化；重复调用抛错（语义同 `initializeApplicationInfrastructure`）。 */
export function initializeTestApplicationInfrastructure(
  input: InitializeTestApplicationInfrastructureInput = {},
): void {
  initializeApplicationInfrastructure({
    database: input.database ?? getDbStub(),
    moduleConfigs: input.moduleConfigs ?? {},
  });
}
