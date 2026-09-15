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

/** 以运行时 JSON 值读取路由响应，避免测试被路由声明中的窄响应类型限制。 */
type ResponseJson = ReturnType<typeof JSON.parse>;

export async function readJson(response: Response): Promise<ResponseJson> {
  return response.json();
}

export {
  getApiKeyServiceStub,
  getAuthApiStub,
  stubApiKeyService,
  stubAuthApi,
  stubAuthHandler,
} from "./stubs/auth-stub";
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
  stubFileWsHandler,
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
