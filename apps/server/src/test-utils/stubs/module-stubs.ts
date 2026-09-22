// 宿主自身模块的 stub 注册表 — 集中管理
// 使用 `@fenix/platform-sdk/testing` 的 createStubRegistry 工厂避免重复代码；平台契约（DB、模块配置、
// 身份目录、认证入口）的替身在那个子路径，本文件只保留宿主模块（services/*、transport/*）的替身。

import { createStubRegistry } from "@fenix/platform-sdk/testing";

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

// ../services/instance — 实例管理服务，2 个测试文件使用
export const instanceRegistry = createStubRegistry("instance", false);

// /agent-runtime/server — 环境 Web API 服务，2 个测试文件使用
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

// workflow 的 pg-storage-adapter / custom-tools 替身不在宿主：owner 包自持，见
// `packages/resources/workflow/src/server/testing.ts`（含「为什么宿主不能再装一份」的实测记录）。

// agent-runtime 的替身（环境仓储、Core runtime facade、Machine 注册端口）同样不在宿主（§1.7 收尾）：
// 接缝由 `packages/agent-runtime/src/server/testing.ts` 自持，宿主用例从那个子路径导入
// （preload 的 `apps/server/src/test-utils/setup-mocks.ts` 只保留「绑定生产实现」的职责）。
// 原先这里的 `stubEnvironmentRepo` / `environmentServiceRegistry` 两个出口已删除：前者迁往该包，
// 后者零消费方——`environmentServiceRegistry` 只被包内用例当作「自己装配 port 替身的中间表」使用，
// 真正的取数已全部经 `getBoundAgentRuntime()`（round44 用例已改为文件内局部登记表）。

// ../transport/file-ws-handler — 文件信道 handler，1 个测试文件使用（W5a 起）
// 注意：这是「部分 mock」（setup-mocks.ts 注册），未配置 stub 时回退真实实现，
// 因此 file-ws-handler.test.ts 无需配置即可保持原有行为。
export const fileWsHandlerRegistry = createStubRegistry("fileWsHandler", false);

// ── 便捷函数导出（对齐已有的 stub 命名风格）──

export const stubRepositories = repositoriesRegistry.stub;
export const stubSession = sessionRegistry.stub;
export const stubEnvironmentCore = environmentCoreRegistry.stub;
export const stubCoreBootstrap = coreBootstrapRegistry.stub;
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
export const stubFileWsHandler = fileWsHandlerRegistry.stub;

// ── 重置函数 ──

export function resetModuleStubs() {
  repositoriesRegistry.reset();
  sessionRegistry.reset();
  environmentCoreRegistry.reset();
  coreBootstrapRegistry.reset();
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
  fileWsHandlerRegistry.reset();
}
