// system API service stub 注册表
// 替代系统级 API 路由测试中对 ../services/system-api 的直接 mock.module 调用

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type StubFn = (...args: any[]) => any;

interface SystemApiStubs {
  listUsers: StubFn;
  getUserById: StubFn;
  listUserApiKeys: StubFn;
  listUserOrganizations: StubFn;
  createUser: StubFn;
  deleteUser: StubFn;
  listOrganizations: StubFn;
  getOrganizationById: StubFn;
  createOrganization: StubFn;
  deleteOrganization: StubFn;
  addOrganizationMember: StubFn;
  createUserApiKey: StubFn;
  deleteUserApiKey: StubFn;
}

let _stubs: Partial<SystemApiStubs> = {};

export function stubSystemApi(overrides: Partial<SystemApiStubs>) {
  _stubs = { ..._stubs, ...overrides };
}

export function getSystemApiStub<K extends keyof SystemApiStubs>(name: K): SystemApiStubs[K] {
  const fn = _stubs[name];
  if (!fn) throw new Error(`system api stub '${String(name)}' not configured, call stubSystemApi() in beforeEach`);
  return fn;
}

export function resetSystemApiStubs() {
  _stubs = {};
}
