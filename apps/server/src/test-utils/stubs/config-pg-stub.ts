// config service stub 注册表
// 替代各测试文件中的 mock.module("../services/config/index", ...) 调用
//
// 键清单必须与各模块的真实函数导出逐一对应：`mock.module` 是整体替换，清单缺少真实导出会让导入方拿到
// `undefined` 而非明确报错。CE 阶段 2 任务 1.2 把 mcp / skill / provider / model 的配置面移入各自的资源包
// （调用方改为资源模块 Facade），这些键随之失效，已删除；纯净函数导出（`parseJsonb` / `parseJsonbOr`）
// 不入清单——它们应由真实实现承担，打桩只会掩盖错误。
//
// 键落在 identity 的 `repositories/user-config`（任务 1.5c 随 `user_config` 表迁出；安装点见
// setup-mocks.ts）。宿主 `services/config` 那一支（`upsertSystemMcpServer`）已作为零消费方死代码删除，
// 其键随之消失。

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type StubFn = (...args: any[]) => any;

interface ConfigPgStubs {
  getUserConfig: StubFn;
  setUserConfig: StubFn;
}

let _stubs: Partial<ConfigPgStubs> = {};

export function stubConfigPg(overrides: Partial<ConfigPgStubs>) {
  _stubs = { ..._stubs, ...overrides };
}

export function getConfigPgStub<K extends keyof ConfigPgStubs>(name: K): ConfigPgStubs[K] {
  const fn = _stubs[name];
  if (!fn) throw new Error(`config service stub '${String(name)}' not configured, call stubConfigPg() in beforeEach`);
  return fn;
}

export function resetConfigPgStubs() {
  _stubs = {};
}
