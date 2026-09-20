import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { mcpServerResource } from "./access/mcp-server-resource";
import type { McpServerFacadeApi } from "./facades/mcp-server-facade";
import { McpServerFacade } from "./facades/mcp-server-facade";
import { createMcpServerRepository, type McpServerQueryStorage } from "./repositories/mcp-server";
import { createMcpServerService, type McpServerService } from "./services/mcp-server-service";

/**
 * MCP Server 资源包组合根。
 *
 * 依赖全部由宿主注入：授权能力来自 `@fenix/access-control`（`createDrizzleAccessControl` 的
 * `accessControl` / `scopeStore` / `authorizedQuery`），身份展示信息来自 `@fenix/identity` 的
 * `IdentityDirectory` 实现。本包不 import 任何具体实现，也不在模块内部保存进程级单例——一次装配
 * 产出一个实例集，测试可以装配自己的实例而互不影响。
 *
 * 已知不足：当前由 `apps/server` 启动流程手工注入，模块注册表尚未表达"平台能力 + 身份目录"这类
 * 构造依赖；registry 驱动的组合根落地时，本函数即模块工厂的目标形状（见
 * `packages/platform/access-control/fenix.module.ts` 的同类说明）。
 */

export interface McpServerModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 宿主汇总全部资源绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 组织名录等展示信息的只读投影；不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface McpServerServerModule {
  /** 资源注册；宿主汇总 `bindings` 时使用，避免两处各写一份归属列。 */
  readonly resource: typeof mcpServerResource;
  /** 协议层入口（授权 + 领域编排）。 */
  readonly facade: McpServerFacadeApi;
  /**
   * 领域服务（无授权判断）。
   *
   * 只有系统初始化路径可直接调用它（例如 Hindsight 托管服务器的幂等写入）；对外路由必须走
   * `facade`，否则会绕过授权。
   */
  readonly service: McpServerService;
  readonly identity: IdentityDirectory;
}

export function createMcpServerServerModule(deps: McpServerModuleDeps): McpServerServerModule {
  const query = narrowAuthorizedQuery<McpServerQueryStorage>(deps.authorizedQuery);
  const service = createMcpServerService(createMcpServerRepository(query));
  return {
    resource: mcpServerResource,
    facade: new McpServerFacade(service, {
      accessControl: deps.accessControl,
      resource: mcpServerResource.definition,
      scopeStore: deps.scopeStore,
    }),
    service,
    identity: deps.identity,
  };
}
