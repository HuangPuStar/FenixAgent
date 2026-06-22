// 统一 stub 注册表 — 所有新增模块的 stub 集中管理
// 使用 createStubRegistry 工厂避免重复代码

import { createStubRegistry } from "./create-stub-registry";

// ── 各模块的 stub 注册表实例 ──
// throwOnMissing=false：未配置时返回空函数而非抛错，
// 因为 preload mock 会在所有测试前生效，未迁移的测试文件不应受影响

// ../repositories — barrel export，10 个测试文件使用
export const repositoriesRegistry = createStubRegistry("repositories", false);

// ../services/session — 会话服务，6 个测试文件使用
// 注意：从 routes 内部导入时路径是 ./session，也是这个模块
export const sessionRegistry = createStubRegistry("session", false);

// ../services/environment-core — 环境核心服务，5 个测试文件使用
// 从 routes 内部导入时路径是 ./environment-core
export const environmentCoreRegistry = createStubRegistry("environmentCore", false);

// ../services/core-bootstrap — 核心运行时引导，5 个测试文件使用
export const coreBootstrapRegistry = createStubRegistry("coreBootstrap", false);

// ../services/launch-spec-builder — 启动规格构建器，5 个测试文件使用
export const launchSpecBuilderRegistry = createStubRegistry("launchSpecBuilder", false);

// ../services/instance — 实例管理服务，2 个测试文件使用
export const instanceRegistry = createStubRegistry("instance", false);

// ../services/environment-web — 环境 Web API 服务，2 个测试文件使用
export const environmentWebRegistry = createStubRegistry("environmentWeb", false);

// ../services/config/skill — skill 配置子模块，2 个测试文件使用
export const configSkillRegistry = createStubRegistry("configSkill", false);

// ../services/config/agent-config — agent 配置子模块，2 个测试文件使用
export const configAgentConfigRegistry = createStubRegistry("configAgentConfig", false);

// ../services/agent-knowledge — agent 知识库绑定，2 个测试文件使用
export const agentKnowledgeRegistry = createStubRegistry("agentKnowledge", false);

// ../services/mcp-inspector — MCP 服务器检测，1 个测试文件使用
export const mcpInspectorRegistry = createStubRegistry("mcpInspector", false);

// ../services/config/mcp-server — MCP 服务器配置，1 个测试文件使用
export const configMcpServerRegistry = createStubRegistry("configMcpServer", false);

// ../repositories/workflow-trigger — workflow trigger repo，1 个测试文件使用
export const workflowTriggerRepoRegistry = createStubRegistry("workflowTriggerRepo", false);

// ../services/workflow-trigger — workflow trigger 服务，1 个测试文件使用
export const workflowTriggerServiceRegistry = createStubRegistry("workflowTriggerService", false);

// ../services/registry — 机器注册服务，1 个测试文件使用
export const registryRegistry = createStubRegistry("registry", false);

// ../services/registry-heartbeat — 心跳检测服务，1 个测试文件使用
export const registryHeartbeatRegistry = createStubRegistry("registryHeartbeat", false);

// ../services/environment — 环境服务，1 个测试文件使用
export const environmentServiceRegistry = createStubRegistry("environmentService", false);

// ../services/knowledge-base — 知识库服务，外部只读接口使用
export const knowledgeBaseServiceRegistry = createStubRegistry("knowledgeBaseService", false);

// ../services/workflow/pg-storage-adapter — PG 存储适配器，1 个测试文件使用
export const pgStorageAdapterRegistry = createStubRegistry("pgStorageAdapter", false);

// ../repositories/environment — 环境仓储（对象导出），1 个测试文件使用
// biome-ignore lint/suspicious/noExplicitAny: repo stub 需要宽松类型
let _environmentRepoStub: Record<string, any> | null = null;
export function stubEnvironmentRepo(overrides: Record<string, unknown>) {
  _environmentRepoStub = { ..._environmentRepoStub, ...overrides };
}
// biome-ignore lint/suspicious/noExplicitAny: repo stub 需要宽松类型
export function getEnvironmentRepoStub(): Record<string, any> | null {
  return _environmentRepoStub;
}
export function resetEnvironmentRepoStub() {
  _environmentRepoStub = null;
}

// ── 便捷函数导出（对齐已有的 stub 命名风格）──

export const stubRepositories = repositoriesRegistry.stub;
export const stubSession = sessionRegistry.stub;
export const stubEnvironmentCore = environmentCoreRegistry.stub;
export const stubCoreBootstrap = coreBootstrapRegistry.stub;
export const stubLaunchSpecBuilder = launchSpecBuilderRegistry.stub;
export const stubInstance = instanceRegistry.stub;
export const stubEnvironmentWeb = environmentWebRegistry.stub;
export const stubConfigSkill = configSkillRegistry.stub;
export const stubConfigAgentConfig = configAgentConfigRegistry.stub;
export const stubAgentKnowledge = agentKnowledgeRegistry.stub;
export const stubMcpInspector = mcpInspectorRegistry.stub;
export const stubConfigMcpServer = configMcpServerRegistry.stub;
export const stubWorkflowTriggerRepo = workflowTriggerRepoRegistry.stub;
export const stubWorkflowTriggerService = workflowTriggerServiceRegistry.stub;
export const stubRegistry = registryRegistry.stub;
export const stubRegistryHeartbeat = registryHeartbeatRegistry.stub;
export const stubEnvironmentService = environmentServiceRegistry.stub;
export const stubKnowledgeBaseService = knowledgeBaseServiceRegistry.stub;
export const stubPgStorageAdapter = pgStorageAdapterRegistry.stub;

// ── 重置函数 ──

export function resetModuleStubs() {
  repositoriesRegistry.reset();
  sessionRegistry.reset();
  environmentCoreRegistry.reset();
  coreBootstrapRegistry.reset();
  launchSpecBuilderRegistry.reset();
  instanceRegistry.reset();
  environmentWebRegistry.reset();
  configSkillRegistry.reset();
  configAgentConfigRegistry.reset();
  agentKnowledgeRegistry.reset();
  mcpInspectorRegistry.reset();
  configMcpServerRegistry.reset();
  workflowTriggerRepoRegistry.reset();
  workflowTriggerServiceRegistry.reset();
  registryRegistry.reset();
  registryHeartbeatRegistry.reset();
  environmentServiceRegistry.reset();
  knowledgeBaseServiceRegistry.reset();
  pgStorageAdapterRegistry.reset();
}
