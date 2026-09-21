import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { createSkillServerModule, type SkillModuleDeps, type SkillServerModule } from "./server/module";
import { installSkillServerModule } from "./server/runtime";

/**
 * Skill 模块的 registry 装配入口（`fenix.module.ts` 的 `create` 目标）。
 *
 * 装配期做三件事：从 `context.modules` 取 access-control 的授权端口、从
 * `@fenix/platform-sdk/server` 取身份目录，然后调用 `./server/module` 的 `createSkillServerModule`
 * 构造实例并装入进程级槽位。真正的构造仍是那一处实现——本文件只补齐「依赖从哪来」。
 *
 * 必须 `install`：路由、builtin 同步与启动参数组装都在调用时经 `getSkillServerModule()` 读取同一份
 * 装配结果，registry 装配完成后没有第二个写入方。不为它登记 cleanup：装配结果里没有需要释放的连接或
 * 句柄（DB 句柄是进程级的，归宿主）；`resetSkillServerModule` 仍只服务测试。
 */
export function createSkillModule(context: ModuleFactoryContext): SkillServerModule {
  const module = createSkillServerModule({
    ...requireAccessControlSuite(context),
    identity: getIdentityDirectory(),
  });
  installSkillServerModule(module);
  return module;
}

/** 本包需要的授权端口子集；形状与 `SkillModuleDeps` 的前三项一致。 */
type AccessControlSuite = Pick<SkillModuleDeps, "accessControl" | "scopeStore" | "authorizedQuery">;

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
    throw new Error("Skill 资源模块装配失败：access-control 模块未提供 accessControl / scopeStore / authorizedQuery");
  }
  return instance as AccessControlSuite;
}
