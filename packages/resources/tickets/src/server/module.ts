import type { GitService } from "@fenix/git/server";
import {
  type AccessControlModule,
  type AuthorizedResourceQuery,
  type IdentityDirectory,
  narrowAuthorizedQuery,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { ticketProjectResource } from "./access/ticket-project-resource";
import { createTicketAttachmentFacade, type TicketAttachmentFacadeApi } from "./facades/ticket-attachment-facade";
import { createTicketCommentFacade, type TicketCommentFacadeApi } from "./facades/ticket-comment-facade";
import { createTicketFacade, type TicketFacadeApi } from "./facades/ticket-facade";
import { createTicketLabelFacade, type TicketLabelFacadeApi } from "./facades/ticket-label-facade";
import { createTicketPlatformFacade, type TicketPlatformFacadeApi } from "./facades/ticket-platform-facade";
import { createTicketProjectFacade, type TicketProjectFacadeApi } from "./facades/ticket-project-facade";
import { createTicketIndexRepository } from "./repositories/ticket-index";
import { createTicketMessageRepository } from "./repositories/ticket-messages";
import { createTicketOperationRepository } from "./repositories/ticket-operations";
import { createTicketProjectRepository, type TicketProjectQueryStorage } from "./repositories/ticket-projects";
import { createTicketAttachmentService } from "./services/ticket-attachment-service";
import { createTicketCommentService } from "./services/ticket-comment-service";
import { createTicketEditService } from "./services/ticket-edit-service";
import { createTicketLabelService } from "./services/ticket-label-service";
import { createTicketOperationService } from "./services/ticket-operation-service";
import { createTicketProjectService } from "./services/ticket-project-service";
import { createTicketRecoveryService } from "./services/ticket-recovery-service";
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
 * 实例复用是有意的：项目服务同时被四个 Facade 使用（工单读写、评论、标签都要先解析可见项目），操作账本
 * 服务同时被项目服务、工单服务、工单修改服务与四个 Facade 使用（幂等领取与 404/202 判定），仓储实例同样
 * 在多条路径间共享（恢复核对要读与其它路径完全相同的表）。各造一份会让同一批表出现多条读改写路径，幂等
 * 与可见性判定随之分叉。
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
  readonly comments: TicketCommentFacadeApi;
  readonly labels: TicketLabelFacadeApi;
  readonly attachments: TicketAttachmentFacadeApi;
  /**
   * 平台管理面（`/api/system/tickets`）：跨组织的列表、详情与写路径，服务系统 API Key 路径。
   *
   * 与上面五个 Facade 并列而不是合并进 `tickets`：它们的判据是 actor（组织内可见性），本面的判据是系统
   * 凭据（路由守卫），合在一起会让「这条路径没有走授权」需要读完整个类才能确认。能力清单见
   * `docs/arch/29-tickets.md` §12.1。
   */
  readonly platform: TicketPlatformFacadeApi;
  readonly identity: IdentityDirectory;
}

/** 只构造，不读 DB、不写单例（测试直接注入替身）。 */
export function createTicketsServerModule(deps: TicketsModuleDeps): TicketsServerModule {
  const query = narrowAuthorizedQuery<TicketProjectQueryStorage>(deps.authorizedQuery);
  const projectsRepository = createTicketProjectRepository(query);
  const operationsRepository = createTicketOperationRepository();
  const operations = createTicketOperationService(operationsRepository);
  const projects = createTicketProjectService({ projects: projectsRepository, operations, git: deps.git });
  const messages = createTicketMessageRepository();
  const index = createTicketIndexRepository();
  const tickets = createTicketService({ messages, index, operations, git: deps.git });
  const edit = createTicketEditService({ messages, index, operations, git: deps.git, identity: deps.identity });
  const comments = createTicketCommentService({ messages, operations, git: deps.git });
  const labels = createTicketLabelService({ operations, git: deps.git });
  const attachments = createTicketAttachmentService({ operations, git: deps.git });
  // 恢复核对（§8.1）只在 `GET /ticket-operations/:operationId` 命中未定状态时跑一次；它读账本与远端，
  // 不写远端。装配在组合根而不是 Facade 里，Facade 因此只依赖一个「取结论」的窄端口。
  const recovery = createTicketRecoveryService({
    git: deps.git,
    projects: projectsRepository,
    operations: operationsRepository,
    index,
    messages,
    identity: deps.identity,
  });

  return {
    resource: ticketProjectResource,
    projects: createTicketProjectFacade({
      accessControl: deps.accessControl,
      scopeStore: deps.scopeStore,
      projects,
      operations,
      identity: deps.identity,
    }),
    tickets: createTicketFacade({
      accessControl: deps.accessControl,
      scopeStore: deps.scopeStore,
      identity: deps.identity,
      projects,
      operations,
      service: tickets,
      edit,
      recovery,
    }),
    comments: createTicketCommentFacade({
      accessControl: deps.accessControl,
      scopeStore: deps.scopeStore,
      identity: deps.identity,
      projects,
      comments,
    }),
    labels: createTicketLabelFacade({
      accessControl: deps.accessControl,
      scopeStore: deps.scopeStore,
      projects,
      labels,
    }),
    attachments: createTicketAttachmentFacade({
      accessControl: deps.accessControl,
      scopeStore: deps.scopeStore,
      projects,
      attachments,
    }),
    // 平台管理面（`/api/system/tickets`）：不吃 actor 与 accessControl，判据在系统路由守卫；复用同一批
    // 领域服务实例，因此跨组织读取与写路径走的仍是与 `/web` 面同一份索引查询与写编排。
    platform: createTicketPlatformFacade({
      tickets,
      projects,
      edit,
      comments,
      labels,
      attachments,
      operations,
      recovery,
      identity: deps.identity,
    }),
    identity: deps.identity,
  };
}
