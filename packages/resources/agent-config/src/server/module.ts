import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { agentConfigResource } from "./access/agent-config-resource";
import { AgentConfigFacade, type AgentConfigFacadeApi } from "./facades/agent-config-facade";
import { type AgentConfigQueryStorage, createAgentConfigRepository } from "./repositories/agent-config-resource";
import { type AgentAssociations, createAgentAssociations } from "./services/agent-associations";
import { type AgentConfigService, createAgentConfigService } from "./services/agent-config-service";

/**
 * AgentConfig 资源包组合根。
 *
 * 依赖全部由注入方提供：授权能力来自 `@fenix/access-control`（`createDrizzleAccessControl` 的
 * `accessControl` / `scopeStore` / `authorizedQuery`），身份展示信息来自 `@fenix/identity` 的
 * `IdentityDirectory` 实现。本包不 import 任何具体实现，也不在模块内部保存进程级单例——一次装配
 * 产出一个实例集，测试可以装配自己的实例而互不影响。
 *
 * 注入方有两种，共用本函数这一处构造：registry 工厂（`src/module.ts` 的 `createAgentConfigModule`，
 * 授权端口取自 `context.modules` 的 access-control 实例、身份目录取自 `@fenix/platform-sdk/server`）
 * 与测试（直接注入替身）。本函数只构造，不读 DB、不写单例，因此两条路径不会互相覆盖。
 */

export interface AgentConfigModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** access-control 汇总全部资源模块声明的绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 组织名录等展示信息的只读投影；不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface AgentConfigServerModule {
  /** 资源注册；manifest 经它声明 `accessControlBindings`，避免两处各写一份归属列。 */
  readonly resource: typeof agentConfigResource;
  /** 协议层入口（授权 + 领域编排 + 跨资源副作用）。 */
  readonly facade: AgentConfigFacadeApi;
  /**
   * 领域服务（无授权判断）。
   *
   * 只有系统初始化路径可直接调用它；对外路由必须走 `facade`，否则会绕过授权。
   */
  readonly service: AgentConfigService;
  /**
   * 关联资源绑定门面（Skill / MCP / SiteApp / 知识库 / 记忆）。
   *
   * 绑定表分散在各自的资源包里，路由经这个门面读写，不直接 import 资源包；绑定集合的合法性
   * （Skill 是否可见、知识库是否属于当前组织）由路由在持有 actor 的层次上先判定。
   */
  readonly associations: AgentAssociations;
  readonly identity: IdentityDirectory;
}

export function createAgentConfigServerModule(deps: AgentConfigModuleDeps): AgentConfigServerModule {
  const query = narrowAuthorizedQuery<AgentConfigQueryStorage>(deps.authorizedQuery);
  const service = createAgentConfigService(createAgentConfigRepository(query));
  return {
    resource: agentConfigResource,
    facade: new AgentConfigFacade(service, {
      accessControl: deps.accessControl,
      resource: agentConfigResource.definition,
      scopeStore: deps.scopeStore,
    }),
    service,
    associations: createAgentAssociations(),
    identity: deps.identity,
  };
}
