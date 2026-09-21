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
 * 依赖全部由注入方提供：授权能力来自 `@fenix/access-control`（`createDrizzleAccessControl` 的
 * `accessControl` / `scopeStore` / `authorizedQuery`），身份展示信息来自 `@fenix/identity` 的
 * `IdentityDirectory` 实现。本包不 import 任何具体实现，也不在模块内部保存进程级单例——一次装配
 * 产出一个实例集，测试可以装配自己的实例而互不影响。
 *
 * 注入方有两种，共用本函数这一处构造：registry 工厂（`src/module.ts` 的 `createMcpModule`，授权端口
 * 取自 `context.modules` 的 access-control 实例、身份目录取自 `@fenix/platform-sdk/server`）与测试
 * （直接注入替身）。本函数只构造，不读 DB、不写单例，因此两条路径不会互相覆盖。
 */

export interface McpServerModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** access-control 汇总全部资源模块声明的绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 组织名录等展示信息的只读投影；不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface McpServerServerModule {
  /** 资源注册；manifest 经它声明 `accessControlBindings`，避免两处各写一份归属列。 */
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
