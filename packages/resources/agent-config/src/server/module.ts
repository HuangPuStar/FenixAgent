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
 * 依赖全部由宿主注入：授权能力来自 `@fenix/access-control`（`createDrizzleAccessControl` 的
 * `accessControl` / `scopeStore` / `authorizedQuery`），身份展示信息来自 `@fenix/identity` 的
 * `IdentityDirectory` 实现。本包不 import 任何具体实现，也不在模块内部保存进程级单例——一次装配
 * 产出一个实例集，测试可以装配自己的实例而互不影响。
 *
 * 已知不足：当前由 `apps/server` 启动流程手工注入，模块注册表尚未表达"平台能力 + 身份目录"这类
 * 构造依赖；registry 驱动的组合根落地时，本函数即模块工厂的目标形状（见
 * `packages/platform/access-control/fenix.module.ts` 的同类说明）。
 */

export interface AgentConfigModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 宿主汇总全部资源绑定后产出的查询端口；存储类型在本包内收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 组织名录等展示信息的只读投影；不由本包实现。 */
  readonly identity: IdentityDirectory;
}

export interface AgentConfigServerModule {
  /** 资源注册；宿主汇总 `bindings` 时使用，避免两处各写一份归属列。 */
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
