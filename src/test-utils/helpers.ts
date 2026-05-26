import { resetAuthStubs } from "./stubs/auth-stub";
import { resetConfigPgStubs } from "./stubs/config-pg-stub";
import { resetDbStub } from "./stubs/db-stub";
import { resetModuleStubs } from "./stubs/module-stubs";

export function resetAllStubs() {
  resetConfigPgStubs();
  resetAuthStubs();
  resetDbStub();
  resetModuleStubs();
}

export { getApiKeyServiceStub, getAuthApiStub, stubApiKeyService, stubAuthApi } from "./stubs/auth-stub";
// 重新导出 stub 函数，方便测试文件从统一入口引入
export { getConfigPgStub, stubConfigPg } from "./stubs/config-pg-stub";
export { stubDb } from "./stubs/db-stub";

// 新增模块 stub — 全部从 module-stubs 统一导出
export {
  stubRepositories,
  stubSession,
  stubEnvironmentCore,
  stubCoreBootstrap,
  stubLaunchSpecBuilder,
  stubInstance,
  stubEnvironmentWeb,
  stubConfigSkill,
  stubConfigAgentConfig,
  stubConfigSkillMetaContent,
  stubAgentKnowledge,
  stubMcpInspector,
  stubConfigMcpServer,
  stubWorkflowTriggerRepo,
  stubWorkflowTriggerService,
} from "./stubs/module-stubs";
