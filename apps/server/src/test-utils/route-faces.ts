import {
  createApiAgentsRoutes,
  createWebAgentGenerationRoutes,
  createWebAgentSitesRoutes,
  createWebConfigAgentsRoutes,
  createWebMetaAgentRoutes,
  createWebSidebarConfigRoutes,
} from "@fenix/agent-config/server";
import {
  createApiInstanceRoutes,
  createOpenaiChatRoutes,
  createWebControlRoutes,
  createWebEnvironmentsRoutes,
  createWebInstancesRoutes,
} from "@fenix/agent-runtime/server";
import {
  createApiSystemRoutes,
  createWebApiKeysRoutes,
  createWebOrganizationsRoutes,
  rotateCallerApiKey,
} from "@fenix/identity/server";
import {
  createApiModelsRoutes,
  createApiSystemModelGatewayRoutes,
  createWebConfigModelsRoutes,
  createWebConfigProvidersRoutes,
  createWebModelGatewayRoutes,
  createWebPeriTaskDetailsRoutes,
} from "@fenix/model-management/server";
import { createWebChannelsRoutes } from "@fenix/resource-channel/server";
import { createApiKnowledgeBaseRoutes, createWebKnowledgeBaseRoutes } from "@fenix/resource-knowledge/server";
import {
  createApiWorkspaceRoutes,
  createWebFileEventsRoutes,
  createWebFsRoutes,
  createWebRegistryRoutes,
} from "@fenix/resource-machine/server";
import { createApiMcpRoutes, createWebMcpConfigRoutes } from "@fenix/resource-mcp/server";
import { createWebHindsightRoutes } from "@fenix/resource-memory/server";
import {
  createApiSystemLogsRoutes,
  createApiSystemObserverRoutes,
  createApiSystemPeopleTreeRoutes,
} from "@fenix/resource-observer/server";
import { createWebConfigProdViewsRoutes, createWebProdViewsRoutes } from "@fenix/resource-prod-view/server";
import {
  createApiSandboxClusterRoutes,
  createApiSandboxRoutes,
  createApiSandboxServerRoutes,
  createWebSandboxPoolsRoutes,
} from "@fenix/resource-sandbox/server";
import { createApiSkillsRoutes, createWebSkillsConfigRoutes } from "@fenix/resource-skill/server";
import { createWebTasksV2Routes } from "@fenix/resource-task/server";
import {
  createApiWorkflowRoutes,
  createWebWorkflowCustomToolsRoutes,
  createWebWorkflowDefsRoutes,
  createWebWorkflowEngineRoutes,
  createWebWorkflowRunsRoutes,
  createWebWorkflowSseRoutes,
} from "@fenix/resource-workflow/server";
import type { AnyElysia } from "elysia";
import { authenticateRequest, authGuardPlugin } from "../plugins/auth";
import { logError } from "../plugins/logger";
import { systemApiAuthPlugin } from "../plugins/system-api-auth";
import {
  environmentLookup,
  resolveSecretReference,
  userAgentPreferences,
  userModelPreferences,
  verifyEnvironmentOwnership,
} from "../services/resource-module-ports";

/**
 * 测试用的 `/web`、`/web/config` 与 `/api` 面路由集合：各包路由工厂 + 宿主端口实现。
 *
 * 生产这三面由 registry 装配的路由贡献提供（1.5e 起 `/web` 两面全量迁入、1.5f 起 `/api` 面全量迁入，宿主
 * 聚合只按槽挂载）；需要「真实路由」但不关心装配语义的用例走本 helper。三面的内容与顺序以
 * `__tests__/route-contributions.test.ts` 的 `toEqual` 断言为准——本文件与它漂移时，那边的失败就是信号。
 *
 * 不镜像顶层 `app` 槽（`/acp`、`/mcp/knowledge`、`/skills/:name/download`、`/workflow-ui`、
 * `/hooks/:publicHash`、站点代理与 `/app-*` 兜底）：这些协议入口各自带独立前缀与认证口径，包内用例已在
 * 各自的包内测试里覆盖（`acp-routes-auth.test.ts`、`hooks-routes.test.ts`、`workflow-static-proxy.test.ts`、
 * `mcp-knowledge-route.test.ts`），宿主侧没有需要「真实路由面」的用例。留白是有意的：多一份无人消费的
 * 镜像只会多一处需要同步的漂移源。
 *
 * 不直接跑 `bootstrapServerAssembly` 的原因：它要求基础设施已初始化，而
 * `initializeApplicationInfrastructure` 每进程只允许调用一次（重复调用抛错）——测试进程里真实装配由
 * `__tests__/route-contributions.test.ts` 独占；preload 刻意不初始化基础设施，理由见
 * `test-utils/setup-mocks.ts`（platform-sdk 的 server-infrastructure.test.ts 依赖「未初始化即失败」）。
 *
 * 三面的排列顺序都与装配收集顺序（拓扑序 + manifest 内声明序）一致：同路径冲突时的匹配结果取决于挂载
 * 顺序，用例要看到与生产相同的形状。端口取 `plugins/auth`、`plugins/logger`、`plugins/system-api-auth` 与
 * `services/resource-module-ports.ts` 的真实实现而不是替身：使用本 helper 的用例断言「协议层把资源 Facade
 * 的输出映射成视图」，端口本身要跑真实实现。
 */

/**
 * 已由贡献提供的 `/web` 面路由；顺序与装配收集顺序一致（见文件头）。
 *
 * 调用方是 `createWebApp({ web: createTestWebRoutes(), ... })`：宿主手写序列只剩 `branding` 与
 * `/web/config` 聚合实例，`/web` 面的包路由全部在这里。
 */
export function createTestWebRoutes(): readonly AnyElysia[] {
  return [
    createWebApiKeysRoutes({ authGuardPlugin }),
    createWebOrganizationsRoutes({ authGuardPlugin }),
    createWebControlRoutes({ authGuardPlugin }),
    createWebEnvironmentsRoutes({ authGuardPlugin }),
    createWebInstancesRoutes({ authGuardPlugin }),
    createWebKnowledgeBaseRoutes({ authGuardPlugin }),
    createWebHindsightRoutes({ authGuardPlugin }),
    createWebSidebarConfigRoutes(),
    createWebAgentSitesRoutes({ authGuardPlugin }),
    createWebAgentGenerationRoutes({ authGuardPlugin }),
    createWebMetaAgentRoutes({ authGuardPlugin, rotateCallerApiKey }),
    createWebChannelsRoutes({ authGuardPlugin, environmentLookup }),
    createWebFsRoutes({ authGuardPlugin }),
    createWebFileEventsRoutes({ authenticateRequest }),
    createWebRegistryRoutes({ authGuardPlugin }),
    createWebModelGatewayRoutes({ authGuardPlugin }),
    createWebPeriTaskDetailsRoutes({ authGuardPlugin, getOwnedEnvironment: verifyEnvironmentOwnership }),
    createWebProdViewsRoutes({ authGuardPlugin }),
    createWebTasksV2Routes({ authGuardPlugin }),
    createWebWorkflowDefsRoutes({ authGuardPlugin }),
    createWebWorkflowCustomToolsRoutes({ authGuardPlugin }),
    createWebWorkflowEngineRoutes({ authGuardPlugin }),
    createWebWorkflowSseRoutes({ authGuardPlugin }),
    createWebWorkflowRunsRoutes({ authGuardPlugin }),
  ];
}

/** 已由贡献提供的 `/web/config` 面路由；顺序与装配收集顺序一致（见文件头）。 */
export function createTestWebConfigRoutes(): readonly AnyElysia[] {
  return [
    createWebMcpConfigRoutes({ authGuardPlugin }),
    createWebSkillsConfigRoutes({ authGuardPlugin }),
    createWebConfigAgentsRoutes({ authGuardPlugin, userAgentPreferences }),
    createWebConfigModelsRoutes({ authGuardPlugin, userModelPreferences }),
    createWebConfigProvidersRoutes({ authGuardPlugin, resolveSecretReference }),
    createWebConfigProdViewsRoutes({ authGuardPlugin }),
    createWebSandboxPoolsRoutes({ authGuardPlugin }),
  ];
}

/**
 * 已由贡献提供的 `/api` 面路由；顺序与装配收集顺序一致（见文件头）。
 *
 * 调用方是 `createApiApp({ api: createTestApiRoutes() })`。会话守卫面与系统 API 守卫面在同一个实例里按
 * 装配序交错（identity 的 `/api/system/*` 在最前，随后是 agent-runtime 两条会话守卫路由，sandbox 的三条
 * 系统 API 路由在末尾之前），因此系统 API 用例与对外 API 用例都能拿到与生产同形的实例。
 */
export function createTestApiRoutes(): readonly AnyElysia[] {
  return [
    createApiSystemRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiInstanceRoutes({ authGuardPlugin, logError }),
    createOpenaiChatRoutes({ authGuardPlugin }),
    createApiKnowledgeBaseRoutes({ authGuardPlugin }),
    createApiMcpRoutes({ authGuardPlugin }),
    createApiSkillsRoutes({ authGuardPlugin }),
    createApiAgentsRoutes({ authGuardPlugin }),
    createApiWorkspaceRoutes({ authGuardPlugin }),
    createApiModelsRoutes({ authGuardPlugin }),
    createApiSystemModelGatewayRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiSystemObserverRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiSystemLogsRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiSystemPeopleTreeRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiSandboxRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiSandboxClusterRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiSandboxServerRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }),
    createApiWorkflowRoutes({ authGuardPlugin }),
  ];
}
