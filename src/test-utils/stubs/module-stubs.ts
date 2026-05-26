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

// ../services/config/skill-meta-content — meta skill 内容，2 个测试文件使用
export const configSkillMetaContentRegistry = createStubRegistry("configSkillMetaContent", false);

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
export const stubConfigSkillMetaContent = configSkillMetaContentRegistry.stub;
export const stubAgentKnowledge = agentKnowledgeRegistry.stub;
export const stubMcpInspector = mcpInspectorRegistry.stub;
export const stubConfigMcpServer = configMcpServerRegistry.stub;
export const stubWorkflowTriggerRepo = workflowTriggerRepoRegistry.stub;
export const stubWorkflowTriggerService = workflowTriggerServiceRegistry.stub;

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
  configSkillMetaContentRegistry.reset();
  agentKnowledgeRegistry.reset();
  mcpInspectorRegistry.reset();
  configMcpServerRegistry.reset();
  workflowTriggerRepoRegistry.reset();
  workflowTriggerServiceRegistry.reset();
}
