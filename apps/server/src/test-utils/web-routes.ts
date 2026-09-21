import { createWebConfigAgentsRoutes } from "@fenix/agent-config/server";
import {
  createWebControlRoutes,
  createWebEnvironmentsRoutes,
  createWebInstancesRoutes,
} from "@fenix/agent-runtime/server";
import { createWebApiKeysRoutes, createWebOrganizationsRoutes } from "@fenix/identity/server";
import { createWebConfigModelsRoutes, createWebConfigProvidersRoutes } from "@fenix/model-management/server";
import { createWebChannelsRoutes } from "@fenix/resource-channel/server";
import { createWebKnowledgeBaseRoutes } from "@fenix/resource-knowledge/server";
import { createWebFileEventsRoutes, createWebFsRoutes, createWebRegistryRoutes } from "@fenix/resource-machine/server";
import { createWebMcpConfigRoutes } from "@fenix/resource-mcp/server";
import { createWebHindsightRoutes } from "@fenix/resource-memory/server";
import { createWebProdViewsRoutes } from "@fenix/resource-prod-view/server";
import { createWebSandboxPoolsRoutes } from "@fenix/resource-sandbox/server";
import { createWebSkillsConfigRoutes } from "@fenix/resource-skill/server";
import { createWebTasksV2Routes } from "@fenix/resource-task/server";
import {
  createWebWorkflowCustomToolsRoutes,
  createWebWorkflowDefsRoutes,
  createWebWorkflowEngineRoutes,
  createWebWorkflowRunsRoutes,
  createWebWorkflowSseRoutes,
} from "@fenix/resource-workflow/server";
import type { AnyElysia } from "elysia";
import { authenticateRequest, authGuardPlugin } from "../plugins/auth";
import {
  environmentLookup,
  resolveSecretReference,
  userAgentPreferences,
  userModelPreferences,
} from "../services/resource-module-ports";

/**
 * 测试用的 `/web` 与 `/web/config` 面路由集合：各包路由工厂 + 宿主端口实现。
 *
 * 生产这两面由 registry 装配的路由贡献提供（1.5e 起逐包迁入，宿主聚合只按槽挂载）；需要「真实路由」但
 * 不关心装配语义的用例走本 helper。
 *
 * 不直接跑 `bootstrapServerAssembly` 的原因：它要求基础设施已初始化，而
 * `initializeApplicationInfrastructure` 每进程只允许调用一次（重复调用抛错）——测试进程里真实装配由
 * `__tests__/route-contributions.test.ts` 独占；preload 刻意不初始化基础设施，理由见
 * `test-utils/setup-mocks.ts`（platform-sdk 的 server-infrastructure.test.ts 依赖「未初始化即失败」）。
 *
 * 两面的排列顺序都与装配收集顺序（拓扑序 + manifest 内声明序）一致：同路径冲突时的匹配结果取决于挂载
 * 顺序，用例要看到与生产相同的形状。端口取 `plugins/auth` 与 `services/resource-module-ports.ts` 的真实
 * 实现而不是替身：使用本 helper 的用例断言「协议层把资源 Facade 的输出映射成视图」，端口本身要跑真实实现。
 */

/**
 * 已由贡献提供的 `/web` 面路由。
 *
 * 仍在宿主 `routes/web/index.ts` 手写序列里的 6 条（agent-config 4、model-management 2）不在这里——它们由
 * `createWebApp` 自己挂载，本 helper 只补贡献侧（调用方是 `createWebApp({ web: createTestWebRoutes(), ... })`）。
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
    createWebChannelsRoutes({ authGuardPlugin, environmentLookup }),
    createWebFsRoutes({ authGuardPlugin }),
    createWebFileEventsRoutes({ authenticateRequest }),
    createWebRegistryRoutes({ authGuardPlugin }),
    createWebProdViewsRoutes({ authGuardPlugin }),
    createWebTasksV2Routes({ authGuardPlugin }),
    createWebWorkflowDefsRoutes({ authGuardPlugin }),
    createWebWorkflowCustomToolsRoutes({ authGuardPlugin }),
    createWebWorkflowEngineRoutes({ authGuardPlugin }),
    createWebWorkflowSseRoutes({ authGuardPlugin }),
    createWebWorkflowRunsRoutes({ authGuardPlugin }),
  ];
}

/** 已由贡献提供的 `/web/config` 面路由；顺序与迁移前宿主手写序列一致。 */
export function createTestWebConfigRoutes(): readonly AnyElysia[] {
  return [
    createWebConfigProvidersRoutes({ authGuardPlugin, resolveSecretReference }),
    createWebSandboxPoolsRoutes({ authGuardPlugin }),
    createWebConfigModelsRoutes({ authGuardPlugin, userModelPreferences }),
    createWebConfigAgentsRoutes({ authGuardPlugin, userAgentPreferences }),
    createWebSkillsConfigRoutes({ authGuardPlugin }),
    createWebMcpConfigRoutes({ authGuardPlugin }),
  ];
}
