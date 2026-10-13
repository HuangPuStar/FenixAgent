import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import {
  createModelManagementServerModule,
  type ModelManagementModuleDeps,
  type ModelManagementServerModule,
} from "./server/module";
import { installModelManagementModule } from "./server/module-runtime";

/**
 * Model-management 模块的 registry 装配入口。
 *
 * 装配期做三件事：从 `context.modules` 取 access-control 的授权端口、从
 * `@fenix/platform-sdk/server` 取身份目录，然后调用 `./server/module` 的
 * `createModelManagementServerModule` 构造实例并装入进程级槽位。真正的构造仍是那一处实现——本文件
 * 只补齐「依赖从哪来」。
 *
 * 必须 `install`：`/web/config/providers`、`/web/config/models`、`/api/models` 与模型网关的
 * provider 同步都在调用时经 `getModelManagementModule()` 读取同一份结果。装配结果里没有需要释放的
 * 连接或句柄，因此不登记 cleanup；`resetModelManagementModule` 仍只服务测试。
 *
 * 模型网关服务集（`ModelGatewayServices`）**不在这里装配**：它由宿主在 `initModelGateway` 阶段经
 * `createModelGatewayRuntime` 建立（依赖进程级凭据与预算配置），§1.5 的裁定是 registry 不接管启动序。
 */
export function createModelManagementModule(context: ModuleFactoryContext): ModelManagementServerModule {
  const module = createModelManagementServerModule({
    ...requireAccessControlSuite(context),
    identity: getIdentityDirectory(),
  });
  installModelManagementModule(module);
  return module;
}

/** 本包需要的授权端口子集；形状与 `ModelManagementModuleDeps` 的前三项一致。 */
type AccessControlSuite = Pick<ModelManagementModuleDeps, "accessControl" | "scopeStore" | "authorizedQuery">;

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
      "ModelManagement 资源模块装配失败：access-control 模块未提供 accessControl / scopeStore / authorizedQuery",
    );
  }
  return instance as AccessControlSuite;
}
