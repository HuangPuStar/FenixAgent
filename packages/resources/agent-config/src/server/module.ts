import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { agentConfigResource } from "./access/agent-config-resource";
import { agentSiteAppResource } from "./access/agent-site-app-resource";
import { type AgentAuthoringFacadeApi, createAgentAuthoringFacade } from "./facades/agent-authoring-facade";
import { AgentConfigFacade, type AgentConfigFacadeApi } from "./facades/agent-config-facade";
import { AgentSiteAppFacade, type AgentSiteAppFacadeApi } from "./facades/agent-site-app-facade";
import { type AgentConfigQueryStorage, createAgentConfigRepository } from "./repositories/agent-config-resource";
import { type AgentSiteAppQueryStorage, createAgentSiteAppRepository } from "./repositories/agent-site-app";
import { type AgentAssociations, createAgentAssociations } from "./services/agent-associations";
import { type AgentConfigService, createAgentConfigService } from "./services/agent-config-service";
import { createAgentSiteAppService } from "./services/agent-site-app-service";

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
  /** 站点 App 的资源注册：`agent_site_app` 也是受控资源，与 AgentConfig 同批交给授权栈。 */
  readonly siteResource: typeof agentSiteAppResource;
  /** 协议层入口（授权 + 领域编排 + 跨资源副作用）。 */
  readonly facade: AgentConfigFacadeApi;
  /** 站点 App 的协议层入口（授权 + 远端平台编排 + 发布范围缓存）。 */
  readonly siteFacade: AgentSiteAppFacadeApi;
  /**
   * Agent 编写面入口（智能生成 + 关联绑定同步）。
   *
   * 与 `associations` 的分工：`associations` 是绑定表的读写门面（不认识 actor），本门面持有主体，
   * 负责把"当前主体可见的 Skill 范围"算好再交给它——`ActorContext` 因此不进入领域服务。
   */
  readonly authoring: AgentAuthoringFacadeApi;
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
  const authorization = {
    accessControl: deps.accessControl,
    scopeStore: deps.scopeStore,
  };
  const siteService = createAgentSiteAppService(
    createAgentSiteAppRepository(narrowAuthorizedQuery<AgentSiteAppQueryStorage>(deps.authorizedQuery)),
  );
  const associations = createAgentAssociations();
  return {
    resource: agentConfigResource,
    siteResource: agentSiteAppResource,
    facade: new AgentConfigFacade(service, { ...authorization, resource: agentConfigResource.definition }),
    siteFacade: new AgentSiteAppFacade(siteService, {
      ...authorization,
      resource: agentSiteAppResource.definition,
    }),
    service,
    associations,
    authoring: createAgentAuthoringFacade(associations),
    identity: deps.identity,
  };
}
