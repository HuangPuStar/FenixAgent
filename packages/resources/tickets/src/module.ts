import type { GitService } from "@fenix/git/server";
import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { createTicketsServerModule, type TicketsModuleDeps, type TicketsServerModule } from "./server/module";
import { installTicketsServerModule } from "./server/runtime";

/**
 * 工单模块的 registry 装配入口（`fenix.module.ts` 的 `create` 目标）。
 *
 * 三件事：从 `context.modules` 取 git 与 access-control 端口、从平台 SDK 取身份目录，然后交给
 * `./server/module` 唯一构造。**不**调用 `@fenix/git/server` 的 `getGitService()`：那是包内进程级单例，
 * 装配顺序由 dependsOn 保证时它恰好可用，但它把「依赖来自装配声明」变成「依赖来自全局状态」——
 * 测试无法注入替身，profile 变更也不会在这里暴露。
 */
export function createTicketsModule(context: ModuleFactoryContext): TicketsServerModule {
  const module = createTicketsServerModule({
    ...requireAccessControlSuite(context),
    git: requireGitService(context),
    identity: getIdentityDirectory(),
  });
  installTicketsServerModule(module);
  return module;
}

/** 本包需要的授权端口子集；形状与 `TicketsModuleDeps` 的前三项一致。 */
type AccessControlSuite = Pick<TicketsModuleDeps, "accessControl" | "scopeStore" | "authorizedQuery">;

function requireAccessControlSuite(context: ModuleFactoryContext): AccessControlSuite {
  const instance = context.modules.get("access-control") as Partial<AccessControlSuite> | undefined;
  if (!instance?.accessControl || !instance.scopeStore || !instance.authorizedQuery) {
    throw new Error("工单资源模块装配失败：access-control 模块未提供 accessControl / scopeStore / authorizedQuery");
  }
  return instance as AccessControlSuite;
}

/**
 * 收窄 registry 注入的 git 实例。
 *
 * 本包只 import `@fenix/git` 的**公开契约**（依赖矩阵允许 resource → common），`context.modules` 的值是
 * `unknown`，因此这里按 `GitService` 的形状做一次显式收窄。端口缺失当场失败：静默退让会让所有工单端点
 * 以「仓库未绑定」响应，把装配故障伪装成业务结果。
 */
function requireGitService(context: ModuleFactoryContext): GitService {
  const instance = context.modules.get("git") as Partial<GitService> | undefined;
  if (!instance?.createScopedClient || !instance.admin || !Array.isArray(instance.connectionIds)) {
    throw new Error(
      "工单资源模块装配失败：git 模块未提供 GitService（需要 connectionIds / createScopedClient / admin）",
    );
  }
  return instance as GitService;
}
