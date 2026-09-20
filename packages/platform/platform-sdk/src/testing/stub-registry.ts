/**
 * 通用替身注册表工厂：按「模块 + 函数名」登记与读取替身函数。
 *
 * 供各包的 `/server/testing` 与宿主 test-utils 构造自己的注册表，避免每个模块重复实现同一模式。
 *
 * 语义（调用方依赖这三条）：
 * - `stub()` 是浅合并（累加覆盖），同一用例可以分多次登记不同函数；
 * - `get()` 在未登记时按 `throwOnMissing` 决定抛错还是返回空函数。默认抛错——忘记登记必须立刻暴露，
 *   否则被测代码会拿到 `undefined` 并在无关位置报 "not a function"；`false` 只给「preload 期注册的
 *   转发代理」使用，这类替身对多数用例并不相关；
 * - `reset()` 清空本注册表，供用例之间复位。
 */

// biome-ignore lint/suspicious/noExplicitAny: 替身注册表要承载任意模块的任意函数签名，读取方在本层之后收窄
type StubFunction = (...args: any[]) => any;

/** 替身注册表：一个实例对应一个模块。 */
export interface StubRegistry {
  /** 浅合并登记替身函数。 */
  stub: (overrides: Record<string, StubFunction>) => void;
  /** 读取替身函数；未登记时按创建参数决定抛错或返回空函数。 */
  get: (name: string) => StubFunction;
  /** 判断某个函数是否已被用例登记（用于「未登记时回退真实实现」的部分替身）。 */
  has: (name: string) => boolean;
  /** 清空全部替身。 */
  reset: () => void;
}

export function createStubRegistry(moduleName: string, throwOnMissing = true): StubRegistry {
  let stubs: Record<string, StubFunction> = {};

  return {
    stub(overrides) {
      stubs = { ...stubs, ...overrides };
    },
    get(name) {
      const fn = stubs[name];
      if (!fn) {
        if (throwOnMissing)
          throw new Error(
            `${moduleName} stub '${name}' not configured, call stub${capitalize(moduleName)}() in beforeEach`,
          );
        // 未配置且不抛错时返回空函数，避免 preload 阶段或非相关测试报错
        return () => {};
      }
      return fn;
    },
    has(name) {
      return name in stubs;
    },
    reset() {
      stubs = {};
    },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
