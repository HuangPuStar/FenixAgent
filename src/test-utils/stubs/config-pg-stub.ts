// config-pg stub 注册表
// 替代各测试文件中的 mock.module("../services/config-pg", ...) 调用

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type StubFn = (...args: any[]) => any;

interface ConfigPgStubs {
  AGENT_SETTABLE_FIELDS: string[];
  addModel: StubFn;
  createAgentConfig: StubFn;
  createMcpServer: StubFn;
  deleteAgentConfig: StubFn;
  deleteMcpServer: StubFn;
  deleteProvider: StubFn;
  deleteSkill: StubFn;
  getAgentConfig: StubFn;
  getAgentConfigById: StubFn;
  getAgentFullConfig: StubFn;
  getMcpServer: StubFn;
  getProvider: StubFn;
  getSkill: StubFn;
  getSkillByResourceKey: StubFn;
  getUserConfig: StubFn;
  listAgentConfigs: StubFn;
  listAgentSkillIds: StubFn;
  listMcpServers: StubFn;
  listProviders: StubFn;
  listSkills: StubFn;
  removeModel: StubFn;
  setMcpServerEnabled: StubFn;
  setUserConfig: StubFn;
  syncAgentSkills: StubFn;
  updateAgentConfig: StubFn;
  updateMcpServer: StubFn;
  updateModel: StubFn;
  upsertProvider: StubFn;
  upsertSkill: StubFn;
}

let _stubs: Partial<ConfigPgStubs> = {};

export function stubConfigPg(overrides: Partial<ConfigPgStubs>) {
  _stubs = { ..._stubs, ...overrides };
}

export function getConfigPgStub<K extends keyof ConfigPgStubs>(name: K): ConfigPgStubs[K] {
  const fn = _stubs[name];
  if (!fn) throw new Error(`config-pg stub '${String(name)}' not configured, call stubConfigPg() in beforeEach`);
  return fn;
}

export function resetConfigPgStubs() {
  _stubs = {};
}
