// 通用 stub 注册表工厂
// 避免为每个模块重复编写相同的 stub 模式

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type StubMap = Record<string, any>;

export interface StubRegistry {
  stub: (overrides: StubMap) => void;
  // biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
  get: (name: string) => any;
  has: (name: string) => boolean;
  reset: () => void;
}

export function createStubRegistry(moduleName: string, throwOnMissing = true): StubRegistry {
  let _stubs: StubMap = {};

  return {
    stub(overrides: StubMap) {
      _stubs = { ..._stubs, ...overrides };
    },
    get(name: string) {
      const fn = _stubs[name];
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
    has(name: string) {
      return name in _stubs;
    },
    reset() {
      _stubs = {};
    },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
