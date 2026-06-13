// config service stub 注册表
// 替代各测试文件中的 mock.module("../services/config/index", ...) 调用

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type StubFn = (...args: any[]) => any;

interface ConfigPgStubs {
  AGENT_SETTABLE_FIELDS: string[];
  addModel: StubFn;
  createAgentConfig: StubFn;
  createMcpServer: StubFn;
  deleteAgentConfig: StubFn;
  deleteMcpServerById: StubFn;
  deleteMcpServer: StubFn;
  deleteProviderById: StubFn;
  deleteProvider: StubFn;
  deleteSkill: StubFn;
  assertMcpServerInternalWritableById: StubFn;
  assertMcpServerInternalWritable: StubFn;
  assertAgentConfigInternalWritable: StubFn;
  assertProviderInternalWritableById: StubFn;
  assertProviderInternalWritable: StubFn;
  getAgentConfig: StubFn;
  getAgentConfigById: StubFn;
  getAgentConfigByResourceKey: StubFn;
  getReadableAgentConfigById: StubFn;
  getMcpServerById: StubFn;
  getMcpServer: StubFn;
  getMcpServerByResourceKey: StubFn;
  getProviderById: StubFn;
  getProvider: StubFn;
  getProviderByResourceKey: StubFn;
  getSkill: StubFn;
  getSkillByResourceKey: StubFn;
  getUserConfig: StubFn;
  listAgentConfigs: StubFn;
  listAgentMcpIds: StubFn;
  listAgentSkillIds: StubFn;
  listMcpServers: StubFn;
  listProviders: StubFn;
  listSkills: StubFn;
  removeModel: StubFn;
  removeModelById: StubFn;
  setMcpServerEnabled: StubFn;
  setUserConfig: StubFn;
  syncAgentMcps: StubFn;
  syncAgentSkills: StubFn;
  updateAgentConfig: StubFn;
  updateProviderById: StubFn;
  updateMcpServerById: StubFn;
  updateMcpServer: StubFn;
  updateModel: StubFn;
  updateModelById: StubFn;
  upsertProvider: StubFn;
  upsertSkill: StubFn;
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
