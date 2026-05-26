// repositories stub 注册表
// 替代各测试文件中的 mock.module("../repositories", ...) 调用
// repositories 是 barrel export，包含多个 repo 实例和 workflow 函数

// biome-ignore lint/suspicious/noExplicitAny: repo stub 对象类型复杂
type AnyFn = (...args: any[]) => any;
type StubMap = Record<string, unknown>;

let _stubs: StubMap = {};

const REPO_KEYS = [
  "channelBindingRepo",
  "environmentRepo",
  "agentKnowledgeBindingRepo",
  "knowledgeBaseRepo",
  "knowledgeResourceRepo",
  "sessionRepo",
  "sessionWorkerRepo",
  "shareLinkRepo",
  "scheduledTaskRepo",
  "taskExecutionLogRepo",
  "tokenRepo",
  "workItemRepo",
  "workflowTriggerRepo",
  "createWorkflowDef",
  "deleteWorkflowDef",
  "getVersions",
  "getVersionYaml",
  "getWorkflowDef",
  "listRecoverableWorkflows",
  "listWorkflowDefs",
  "publishVersion",
  "recoverWorkflows",
  "restoreVersionToDraft",
  "saveDraft",
  "setLatestVersion",
  "updateWorkflowMeta",
  "resetAllRepos",
] as const;

export type RepositoryKey = (typeof REPO_KEYS)[number];

export function stubRepositories(overrides: Partial<Record<RepositoryKey, unknown>>) {
  _stubs = { ..._stubs, ...overrides };
}

export function getRepositoryStub(name: string): unknown {
  const fn = _stubs[name];
  if (!fn) throw new Error(`repositories stub '${name}' not configured, call stubRepositories() in beforeEach`);
  return fn;
}

export function resetRepositoryStubs() {
  _stubs = {};
}
