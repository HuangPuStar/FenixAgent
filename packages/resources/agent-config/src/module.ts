import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import {
  type AgentConfigModuleDeps,
  type AgentConfigServerModule,
  createAgentConfigServerModule,
} from "./server/module";
import { installAgentConfigModule } from "./server/runtime";

/**
 * AgentConfig 模块的 registry 装配入口（`fenix.module.ts` 的 `create` 目标）。
 *
 * 装配期做三件事：从 `context.modules` 取 access-control 的授权端口、从
 * `@fenix/platform-sdk/server` 取身份目录，然后调用 `./server/module` 的
 * `createAgentConfigServerModule` 构造实例并装入进程级槽位。真正的构造仍是那一处实现——本文件只补齐
 * 「依赖从哪来」。
 *
 * 必须 `install`：路由、系统入口与 `pre-launch-ports` 都在调用时经 `getAgentConfigModule()` 读取同一
 * 份结果（它是唯一读取点），registry 装配完成后没有第二个写入方。不为它登记 cleanup：装配结果里没有
 * 需要释放的连接或句柄；`resetAgentConfigModule` 仍只服务测试。
 */
export function createAgentConfigModule(context: ModuleFactoryContext): AgentConfigServerModule {
  const module = createAgentConfigServerModule({
    ...requireAccessControlSuite(context),
    identity: getIdentityDirectory(),
  });
  installAgentConfigModule(module);
  return module;
}

/** 本包需要的授权端口子集；形状与 `AgentConfigModuleDeps` 的前三项一致。 */
type AccessControlSuite = Pick<AgentConfigModuleDeps, "accessControl" | "scopeStore" | "authorizedQuery">;

/**
 * 收窄 registry 注入的 access-control 实例。
 *
 * 口径与 `@fenix/resource-mcp` 的 `src/module.ts` 相同（`unknown` 槽位 + 一次显式收窄 + 缺端口当场
 * 报错，不抽到 platform-sdk 的理由见该文件）：本包不 import `@fenix/access-control`，`resources →
 * platform-impl` 被依赖矩阵禁止。
 */
function requireAccessControlSuite(context: ModuleFactoryContext): AccessControlSuite {
  const instance = context.modules.get("access-control") as Partial<AccessControlSuite> | undefined;
  if (!instance?.accessControl || !instance.scopeStore || !instance.authorizedQuery) {
    throw new Error(
      "AgentConfig 资源模块装配失败：access-control 模块未提供 accessControl / scopeStore / authorizedQuery",
    );
  }
  return instance as AccessControlSuite;
}
