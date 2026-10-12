/**
 * 工单 Facade：授权判定 + 项目解析 + 读写编排（backend contract §4.3 / §5.2 / §8.3）。
 *
 * `route → Facade → Domain Service → Repository` 里的授权层：route 只做协议接入与状态码映射，领域服务
 * 不认识 actor。**「谁能读写工单」只在这里判定**，全部经 `AccessControlModule`（基类的 `listConstraint`），
 * 本文件不查成员表、不复制授权 SQL。
 *
 * 判定口径（§5.3）：工单本体不是受控资源行（事实源在托管平台），因此「能读项目 ⟺ 能读写该项目下的工单」
 * 完全由项目行的可见性表达——项目 `read` 动作对成员默认开放，创建工单是这一动作之上的业务动作。读取
 * 一律经 `listConstraint(actor,"read")` + 受控查询：谓词只匹配 actor 的当前组织且要求成员关系成立，
 * 跨组织与不存在因此**同形**返回 404（`NotFoundError`），不给资源 ID 留探测面。
 *
 * 暂停语义只作用于写：项目 `status = "paused"` 时创建工单报 503 `TICKETS_PAUSED` 且**不产生任何上游
 * 调用**，而列表与详情照常可用（暂停保留绑定与历史数据，方案 §8）。
 *
 * 操作可见性（决策 D5）：`getOperation` 只认操作自己的 actor，查不到与不是本人一律 404；本文件不加工会
 * 管理员的额外放行——那是一次需要评审的可见性扩张。
 */

import {
  type AccessControlModule,
  type ActorContext,
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  type IdentityDirectory,
  NotFoundError,
  type ResourceScopeStore,
  ValidationError,
} from "@fenix/platform-sdk";
import { ticketProjectResource } from "../access/ticket-project-resource";
import { OperationNotFoundError, TicketsPausedError } from "../errors";
import type { TicketProjectRow } from "../repositories/ticket-projects";
import { TICKET_LIST_DEFAULT_LIMIT, TICKET_LIST_MAX_LIMIT } from "../services/ticket-limits";
import type { TicketOperationService } from "../services/ticket-operation-service";
import type { TicketProjectService } from "../services/ticket-project-service";
import type { TicketService } from "../services/ticket-service";
import {
  collectFactsActorIds,
  collectIndexActorIds,
  type DisplayNames,
  type TicketDetailView,
  type TicketListPage,
  type TicketOperationView,
  toTicketDetailView,
  toTicketOperationView,
  toTicketSummaryView,
} from "./ticket-view";

export type {
  TicketActorView,
  TicketDetailView,
  TicketListPage,
  TicketOperationView,
  TicketSummaryView,
} from "./ticket-view";

/** 游标是本页末条的工单号（十进制、无前导零）；格式在路由 schema 已校验，这里复检以免非法值进到 SQL 的 `::bigint`。 */
const TICKET_CURSOR_PATTERN = /^[1-9]\d*$/;

export interface TicketListQuery {
  readonly q?: string;
  readonly state?: "open" | "closed" | "all";
  readonly assigneeId?: string;
  readonly labelId?: string;
  readonly cursor?: string;
  /** 默认 30、上限 100（`ticket-limits.ts`）；越界在路由 schema 已挡，这里收敛到合法区间。 */
  readonly limit?: number;
}

export type TicketCreateOutcome =
  | { readonly kind: "created"; readonly ticket: TicketDetailView; readonly operationId: string }
  | { readonly kind: "uncertain"; readonly operationId: string };

export interface TicketFacadeApi {
  list(actor: ActorContext, projectId: string, query: TicketListQuery): Promise<TicketListPage>;
  get(actor: ActorContext, projectId: string, issueNumber: string): Promise<TicketDetailView>;
  create(
    actor: ActorContext,
    projectId: string,
    input: { title: string; body: string },
    idempotencyKey: string,
  ): Promise<TicketCreateOutcome>;
  getOperation(actor: ActorContext, operationId: string): Promise<TicketOperationView>;
}

export interface TicketFacadeDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 只用于展示名解析，绝不参与授权判定（`identity-directory.ts` 的契约边界）。 */
  readonly identity: IdentityDirectory;
  /** 工单领域服务（无授权判断）；由组合根构造，Facade 不接触仓储。 */
  readonly service: TicketService;
  /** 项目领域服务：读写工单前先解析出可见项目（授权条件由本层传入）。 */
  readonly projects: TicketProjectService;
  /** 操作账本：`getOperation` 的可见性判定（决策 D5）。 */
  readonly operations: TicketOperationService;
}

class TicketFacade extends AuthorizedResourceFacade implements TicketFacadeApi {
  private readonly identity: IdentityDirectory;
  private readonly projects: TicketProjectService;
  private readonly operations: TicketOperationService;
  private readonly service: TicketService;

  constructor(options: AuthorizedResourceFacadeOptions, deps: TicketFacadeDeps) {
    super(options);
    this.identity = deps.identity;
    this.projects = deps.projects;
    this.operations = deps.operations;
    this.service = deps.service;
  }

  async list(actor: ActorContext, projectId: string, query: TicketListQuery) {
    const project = await this.requireProject(actor, projectId);
    const cursor = query.cursor;
    if (cursor !== undefined && !TICKET_CURSOR_PATTERN.test(cursor)) throw new ValidationError("cursor 必须是正整数");
    const page = await this.service.listPage({
      projectId: project.id,
      limit: Math.min(query.limit ?? TICKET_LIST_DEFAULT_LIMIT, TICKET_LIST_MAX_LIMIT),
      ...(cursor === undefined ? {} : { cursor }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.assigneeId === undefined ? {} : { assigneeId: query.assigneeId }),
      ...(query.labelId === undefined ? {} : { labelId: query.labelId }),
    });
    const displayNames = await this.resolveDisplayNames(collectIndexActorIds(page.items));
    return { items: page.items.map((row) => toTicketSummaryView(row, displayNames)), nextCursor: page.nextCursor };
  }

  async get(actor: ActorContext, projectId: string, issueNumber: string) {
    const project = await this.requireProject(actor, projectId);
    const facts = await this.service.getIssue({
      organizationId: project.organizationId,
      projectId: project.id,
      bindingId: project.repositoryRef,
      issueNumber,
    });
    return toTicketDetailView(facts, await this.resolveDisplayNames(collectFactsActorIds(facts)));
  }

  async create(
    actor: ActorContext,
    projectId: string,
    input: { title: string; body: string },
    idempotencyKey: string,
  ): Promise<TicketCreateOutcome> {
    const project = await this.requireProject(actor, projectId);
    // 暂停检查必须在幂等声明之前：它不产生账本行，也不允许出现任何上游调用（§8.3 步骤 2）。
    if (project.status === "paused") throw new TicketsPausedError();

    // 显示名取身份目录的当前值并写进归属快照；查不到时退化为 actorId，保证快照字段永远非空。
    const authorName = (await this.identity.getUser(actor.userId))?.name ?? actor.userId;
    const outcome = await this.service.createIssue({
      organizationId: project.organizationId,
      projectId: project.id,
      bindingId: project.repositoryRef,
      actorId: actor.userId,
      authorName,
      title: input.title,
      body: input.body,
      idempotencyKey,
    });
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
    return {
      kind: "created",
      ticket: toTicketDetailView(outcome.facts, await this.resolveDisplayNames(collectFactsActorIds(outcome.facts))),
      operationId: outcome.operationId,
    };
  }

  async getOperation(actor: ActorContext, operationId: string): Promise<TicketOperationView> {
    const organizationId = actor.activeOrganizationId;
    // 没有组织上下文就看不到任何账本行：与「不是本人」同形返回 404，不区分原因。
    if (organizationId === undefined) throw new OperationNotFoundError();
    const row = await this.operations.findForActor({ organizationId, actorId: actor.userId, operationId });
    if (row === undefined) throw new OperationNotFoundError();
    return toTicketOperationView(row);
  }

  /**
   * 解析可见项目；不存在、跨组织与「当前组织里已没有成员关系」都在这里收敛成同一个 404。
   *
   * 不额外调 `authorizeAction(actor,"read",projectId)`：受控查询的谓词与单资源动作判定同源，而项目行本身
   * 就是后续动作需要的坐标（组织、绑定、状态）。多查一次既不改结论，也会让 404 与 403 的分界出现两处。
   */
  private async requireProject(actor: ActorContext, projectId: string): Promise<TicketProjectRow> {
    const access = await this.listConstraint(actor, "read");
    const project = await this.projects.findReadable({ access, projectId });
    if (project === undefined) throw new NotFoundError("工单项目不存在");
    return project;
  }

  /** 一次批量解析本请求会展示到的 AOS 主体；空集合不发查询（列表全为外部来源时不该产生多余往返）。 */
  private async resolveDisplayNames(userIds: readonly string[]): Promise<DisplayNames> {
    if (userIds.length === 0) return new Map();
    return this.identity.listUserDisplayInfo(userIds);
  }
}

/** 构造工单 Facade；只构造不读 DB、不写单例，测试可注入替身（§4.1）。 */
export function createTicketFacade(deps: TicketFacadeDeps): TicketFacadeApi {
  return new TicketFacade(
    {
      accessControl: deps.accessControl,
      resource: ticketProjectResource.definition,
      scopeStore: deps.scopeStore,
    },
    deps,
  );
}
