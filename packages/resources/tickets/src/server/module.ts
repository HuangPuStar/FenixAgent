import type { GitService } from "@fenix/git/server";
import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { ticketProjectResource } from "./access/ticket-project-resource";
import { createTicketFacade, type TicketFacadeApi } from "./facades/ticket-facade";
import { createTicketProjectFacade, type TicketProjectFacadeApi } from "./facades/ticket-project-facade";
import { createTicketIndexRepository } from "./repositories/ticket-index";
import { createTicketMessageRepository } from "./repositories/ticket-messages";
import { createTicketOperationRepository } from "./repositories/ticket-operations";
import { createTicketProjectRepository, type TicketProjectQueryStorage } from "./repositories/ticket-projects";
import { createTicketOperationService } from "./services/ticket-operation-service";
import { createTicketProjectService } from "./services/ticket-project-service";
import { createTicketService } from "./services/ticket-service";

/**
 * 工单资源包组合根（backend contract §4.1）。
 *
 * 依赖全部由注入方提供：授权能力来自 `@fenix/access-control`（`accessControl` / `scopeStore` /
 * `authorizedQuery`），仓库与 Issue 的事实源来自 `@fenix/git` 的 `GitService`，身份展示投影来自
 * `@fenix/identity` 的 `IdentityDirectory`。本包不 import 任何具体实现，也不在模块内部保存进程级单例
 * ——一次装配产出一个实例集，测试可以装配自己的实例而互不影响；进程级槽位由 `./runtime` 单独持有。
 *
 * 注入方有两种，共用本函数这一处构造：registry 工厂（`src/module.ts` 的 `createTicketsModule`，依赖取自
 * `context.modules` 与平台 SDK）与测试（直接注入替身，见 §10）。本函数只构造，不读 DB、不写单例。
 *
 * 实例复用是有意的：项目服务同时被两个 Facade 使用（工单读写要先解析可见项目），操作账本服务同时被
 * 项目服务、工单服务与两个 Facade 使用（幂等领取与 404/202 判定）。各造一份会让同一批表出现多条读改写
 * 路径，幂等与可见性判定随之分叉。
 */

export interface TicketsModuleDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** access-control 汇总全部资源绑定后产出的查询端口；存储类型在本包收窄。 */
  readonly authorizedQuery: AuthorizedResourceQuery;
  /** 只用于展示名解析，绝不参与授权判定（`identity-directory.ts` 的契约边界）。 */
  readonly identity: IdentityDirectory;
  /** 仓库与 Issue 的唯一出入口；管理动作走 `git.admin`，日常读写走 `createScopedClient`。 */
  readonly git: GitService;
}

export interface TicketsServerModule {
  /** 资源注册；manifest 经它声明 `accessControlBindings`，避免两处各写一份归属列。 */
  readonly resource: typeof ticketProjectResource;
  readonly projects: TicketProjectFacadeApi;
  readonly tickets: TicketFacadeApi;
  readonly identity: IdentityDirectory;
}

/** 只构造，不读 DB、不写单例（测试直接注入替身）。 */
export function createTicketsServerModule(deps: TicketsModuleDeps): TicketsServerModule {
  const query = narrowAuthorizedQuery<TicketProjectQueryStorage>(deps.authorizedQuery);
  const projectsRepository = createTicketProjectRepository(query);
  const operations = createTicketOperationService(createTicketOperationRepository());
  const projects = createTicketProjectService({ projects: projectsRepository, operations, git: deps.git });
  const tickets = createTicketService({
    messages: createTicketMessageRepository(),
    index: createTicketIndexRepository(),
    operations,
    git: deps.git,
  });

  return {
    resource: ticketProjectResource,
    projects: createTicketProjectFacade({
      accessControl: deps.accessControl,
      scopeStore: deps.scopeStore,
      projects,
      operations,
    }),
    tickets: createTicketFacade({
      accessControl: deps.accessControl,
      scopeStore: deps.scopeStore,
      identity: deps.identity,
      projects,
      operations,
      service: tickets,
    }),
    identity: deps.identity,
  };
}
