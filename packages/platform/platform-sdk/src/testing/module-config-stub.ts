/**
 * 模块配置替身（`getModuleConfig()` 契约）。
 *
 * 为什么需要两层（基线 + 覆盖）：宿主测试进程**刻意不初始化应用基础设施**——platform-sdk 的
 * `server-infrastructure.test.ts` 依赖「未初始化时读取必须失败」这一前提，preload 里初始化会让那条
 * 用例失去意义。因此宿主 preload 为 `identity` 之类的模块提供一个「生产默认值 + 用例覆盖」的配置视图；
 * 而 `resetAllStubs()` 在每条用例前都会执行，默认值必须留在基线层才不会被清掉。
 *
 * 包内用例（代码经 `getModuleConfig()` 读配置）应改用
 * {@link initializeTestApplicationInfrastructure}：那是生产路径本身，语义最接近真实装配。
 * 本模块只服务「不能初始化基础设施」的场景（宿主 preload 的模块级 mock）。
 *
 * 未登记任何值的模块读取时抛错，与 `getModuleConfig()` 对未声明模块的严格性一致：默认值缺失必须立刻
 * 暴露，而不是让被测代码拿到 `undefined` 后在更远处失败。
 */

// 值类型声明为 `object` 而不是 `Record<string, unknown>`：模块配置契约是接口（如 `SandboxModuleConfig`），
// 接口类型没有隐式索引签名，收窄成 Record 会强迫每个调用方在入口处做一次无意义的转换。
const baselines = new Map<string, object>();
const overrides = new Map<string, object>();

/** 登记模块配置基线（生产默认值）。preload 期一次性登记；`resetModuleConfigStubs()` 不清除基线。 */
export function registerModuleConfigBaseline(moduleId: string, config: object): void {
  baselines.set(moduleId, { ...config });
}

/** 覆盖模块配置字段（浅合并到基线之上），供用例声明本用例的配置。 */
export function stubModuleConfig(moduleId: string, overridesToApply: object): void {
  overrides.set(moduleId, { ...overrides.get(moduleId), ...overridesToApply });
}

/**
 * 读取当前生效的模块配置（基线 + 覆盖）。
 *
 * 返回类型由调用方用泛型收窄到该模块的配置契约（如 `IdentityConfig`）：契约类型由模块自己拥有，
 * 本注册表不复制一份，避免两处定义漂移。
 */
export function getModuleConfigStub<TConfig = Record<string, unknown>>(moduleId: string): TConfig {
  const baseline = baselines.get(moduleId);
  const override = overrides.get(moduleId);
  if (!baseline && !override) {
    throw new Error(`模块 ${moduleId} 的测试配置未登记，请先 registerModuleConfigBaseline() 或 stubModuleConfig()`);
  }
  return { ...baseline, ...override } as TConfig;
}

/**
 * 该模块是否已登记基线或用例覆盖。
 *
 * 宿主读取 seam（`apps/server/src/test-utils/setup-mocks.ts`）用它区分「替身可用」与「替身不可用」：
 * 未登记时必须让平台原本的「应用基础设施尚未初始化」错误原样抛出，而不是换成这里的「未登记」错误——
 * `server-infrastructure.test.ts` 断言的是前者。
 */
export function hasModuleConfigStub(moduleId: string): boolean {
  return baselines.has(moduleId) || overrides.has(moduleId);
}

/** 清空用例覆盖（保留基线），供用例之间复位。 */
export function resetModuleConfigStubs(): void {
  overrides.clear();
}
