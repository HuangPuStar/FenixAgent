import { createWebConfigAgentsRoutes } from "@fenix/agent-config/server";
import { createWebConfigModelsRoutes, createWebConfigProvidersRoutes } from "@fenix/model-management/server";
import { createWebMcpConfigRoutes } from "@fenix/resource-mcp/server";
import { createWebSandboxPoolsRoutes } from "@fenix/resource-sandbox/server";
import { createWebSkillsConfigRoutes } from "@fenix/resource-skill/server";
import type { AnyElysia } from "elysia";
import { authGuardPlugin } from "../plugins/auth";
import { resolveSecretReference, userAgentPreferences, userModelPreferences } from "../services/resource-module-ports";

/**
 * 测试用的 `/web/config/*` 路由集合：各包路由工厂 + 宿主端口实现。
 *
 * 生产这一面完全由 registry 装配的路由贡献提供（`routes/web/config/index.ts` 只挂贡献，1.5e 起逐包迁入），
 * 需要「真实 config 路由」但不关心装配语义的用例走本 helper。
 *
 * 不直接跑 `bootstrapServerAssembly` 的原因：它要求基础设施已初始化，而
 * `initializeApplicationInfrastructure` 每进程只允许调用一次（重复调用抛错）——测试进程里真实装配由
 * `__tests__/route-contributions.test.ts` 独占；preload 刻意不初始化基础设施，理由见
 * `test-utils/setup-mocks.ts`（platform-sdk 的 server-infrastructure.test.ts 依赖「未初始化即失败」）。
 *
 * 顺序与迁移前宿主手写序列一致：同路径冲突时的匹配结果取决于挂载顺序，用例要看到与生产相同的形状。
 * 端口取宿主 `services/resource-module-ports.ts` 的真实实现而不是替身：这些用例断言「协议层把资源
 * Facade 的输出映射成视图」，端口本身要跑真实实现（读 stub DB / 读进程环境）。
 */
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
