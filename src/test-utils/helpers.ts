import { resetAuthStubs } from "./stubs/auth-stub";
import { resetConfigPgStubs } from "./stubs/config-pg-stub";
import { resetDbStub } from "./stubs/db-stub";
import { resetEnvironmentRepoStub, resetModuleStubs } from "./stubs/module-stubs";
import { resetResourcePermissionRepoStub } from "./stubs/resource-permission-repo-stub";
import { resetSystemApiStubs } from "./stubs/system-api-stub";

export function resetAllStubs() {
  resetConfigPgStubs();
  resetAuthStubs();
  resetDbStub();
  resetModuleStubs();
  resetEnvironmentRepoStub();
  resetResourcePermissionRepoStub();
  resetSystemApiStubs();
}

export { getApiKeyServiceStub, getAuthApiStub, stubApiKeyService, stubAuthApi } from "./stubs/auth-stub";
// 重新导出 stub 函数，方便测试文件从统一入口引入
export { getConfigPgStub, stubConfigPg } from "./stubs/config-pg-stub";
export { stubDb } from "./stubs/db-stub";
// 新增模块 stub — 全部从 module-stubs 统一导出
export {
  stubAgentKnowledge,
  stubConfigAgentConfig,
  stubConfigMcpServer,
  stubConfigSkill,
  stubCoreBootstrap,
  stubEnvironmentCore,
  stubEnvironmentRepo,
  stubEnvironmentService,
  stubEnvironmentWeb,
  stubInstance,
  stubKnowledgeBaseService,
  stubLaunchSpecBuilder,
  stubMcpInspector,
  stubPgStorageAdapter,
  stubRegistry,
  stubRegistryHeartbeat,
  stubRepositories,
  stubSession,
  stubWorkflowTriggerRepo,
  stubWorkflowTriggerService,
} from "./stubs/module-stubs";
export { stubResourcePermissionRepo } from "./stubs/resource-permission-repo-stub";
export { stubSystemApi } from "./stubs/system-api-stub";
