import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { createMcpServerServerModule, type McpServerModuleDeps, type McpServerServerModule } from "./server/module";
import { installMcpServerModule } from "./server/runtime";

/**
 * MCP 模块的 registry 装配入口（`fenix.module.ts` 的 `create` 目标）。
 *
 * 装配期做三件事：从 `context.modules` 取 access-control 的授权端口、从
 * `@fenix/platform-sdk/server` 取身份目录，然后调用 `./server/module` 的
 * `createMcpServerServerModule` 构造实例并装入进程级槽位。真正的构造仍是那一处实现——本文件只补齐
 * 「依赖从哪来」，不复制任何组装逻辑（授权端口、身份目录与资源注册的绑定关系只允许有一处定义）。
 *
 * 必须 `install`：路由、系统初始化路径与 launch spec 都在调用时经 `getMcpServerModule()` 读取同一份
 * 装配结果，registry 装配完成后没有第二个写入方（宿主的手写 `installMcpServerModule` 随 §1.5f 删除）。
 * 不为它登记 cleanup：装配结果里只有 facade / service / repository，全部是无连接、无句柄的普通对象，
 * 进程退出不需要释放；`resetMcpServerModule` 仍只服务测试。
 */
export function createMcpModule(context: ModuleFactoryContext): McpServerServerModule {
  const module = createMcpServerServerModule({
    ...requireAccessControlSuite(context),
    identity: getIdentityDirectory(),
  });
  installMcpServerModule(module);
  return module;
}

/** 本包需要的授权端口子集；形状与 `McpServerModuleDeps` 的前三项一致。 */
type AccessControlSuite = Pick<McpServerModuleDeps, "accessControl" | "scopeStore" | "authorizedQuery">;

/**
 * 收窄 registry 注入的 access-control 实例。
 *
 * `context.modules` 的值是 `unknown`（registry 不解释模块实例的形状），本包不 import
 * `@fenix/access-control`（`resources → platform-impl` 被依赖矩阵禁止），因此这里按包内契约做一次
 * 显式收窄。端口缺失必须当场失败：静默退让会让所有 MCP 端点以「资源不存在」响应，把装配故障伪装成
 * 业务结果。
 *
 * 为什么这段收窄在四个资源包里各写一份、而不抽到 `platform-sdk`：`context.modules` 的值是
 * `unknown`，收窄它需要「access-control 实例的形状」——该形状由 `@fenix/access-control` 定义，
 * `platform-sdk` 不得依赖 platform-impl；SDK 能提供的只有「按端口键取模块实例」的通用助手，那是一项
 * 新公共契约，而本任务只扩展已审核的三项（review §3.2 / §3.3）。四处重复的是同一形状，但各包按自己的
 * deps 类型（`Pick`）与失败文案对齐；提炼的触发条件是「出现第二个非 access-control 的端口也需要同形
 * 收窄」，届时按当时的形状评审这一项助手。
 */
function requireAccessControlSuite(context: ModuleFactoryContext): AccessControlSuite {
  const instance = context.modules.get("access-control") as Partial<AccessControlSuite> | undefined;
  if (!instance?.accessControl || !instance.scopeStore || !instance.authorizedQuery) {
    throw new Error("MCP 资源模块装配失败：access-control 模块未提供 accessControl / scopeStore / authorizedQuery");
  }
  return instance as AccessControlSuite;
}
