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
  ForbiddenError,
  type IdentityDirectory,
  NotFoundError,
  type ResourceScopeStore,
  ValidationError,
} from "@fenix/platform-sdk";
import { ticketProjectResource } from "../access/ticket-project-resource";
import { OperationNotFoundError, TicketsPausedError } from "../errors";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import type { TicketProjectRow } from "../repositories/ticket-projects";
import type {
  TicketEditOutcome,
  TicketEditService,
  TicketLabelSetInput,
  TicketUpdateIssueInput,
} from "../services/ticket-edit-service";
import { TICKET_LIST_DEFAULT_LIMIT, TICKET_LIST_MAX_LIMIT } from "../services/ticket-limits";
import {
  ISSUE_CHANGE_KINDS,
  RECONCILABLE_OPERATION_STATUSES,
  type TicketOperationService,
} from "../services/ticket-operation-service";
import {
  canChangeIssueStateOrAssignee,
  canEditTicketContent,
  type TicketAuthority,
} from "../services/ticket-permission";
import type { TicketProjectService } from "../services/ticket-project-service";
import type { TicketService } from "../services/ticket-service";
import { isProjectAdmin } from "./ticket-action-guard";
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

/**
 * 修改类写路径的统一结果视图（工单 PATCH 与标签挂载同形）。
 *
 * `uncertain` 分支**不带**工单视图：远端可能已写入也可能没有，拼一份本地视图会让调用方以为拿到了权威
 * 内容；前端据 `operationId` 走复核入口（`GET /ticket-operations/:id`）。
 */
export type TicketEditOutcomeView =
  | { readonly kind: "updated"; readonly ticket: TicketDetailView; readonly operationId: string }
  | { readonly kind: "uncertain"; readonly operationId: string };

/** 工单字段修改（PATCH）：字段缺席 = 不改，`assigneeId: null` = 取消指派。 */
export interface TicketUpdateInput {
  readonly expectedVersion: string;
  readonly title?: string;
  readonly body?: string;
  readonly assigneeId?: string | null;
  readonly state?: "open" | "closed";
}

export interface TicketFacadeApi {
  list(actor: ActorContext, projectId: string, query: TicketListQuery): Promise<TicketListPage>;
  get(actor: ActorContext, projectId: string, issueNumber: string): Promise<TicketDetailView>;
  create(
    actor: ActorContext,
    projectId: string,
    input: { title: string; body: string },
    idempotencyKey: string,
  ): Promise<TicketCreateOutcome>;
  /** 修改标题/描述/负责人/状态（§2.1 的两条权限规则按本次触及的字段分别判定）。 */
  update(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: TicketUpdateInput,
    idempotencyKey: string,
  ): Promise<TicketEditOutcomeView>;
  /** 标签挂载（全量集合语义）；权限与标题/描述一致（裁定二.10：创建者或管理员）。 */
  setLabels(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: { labelIds: readonly string[]; expectedVersion: string },
    idempotencyKey: string,
  ): Promise<TicketEditOutcomeView>;
  getOperation(actor: ActorContext, operationId: string): Promise<TicketOperationView>;
}

/**
 * 恢复核对的窄端口（§8.1 / §8.2）：`getOperation` 在返回前对未定状态执行**一次**回源核对。
 *
 * 只声明本层用得上的形状（核对后的账本行），不在这里复制 §8.2 的 `TicketRecoveryOutcome` 联合类型：
 * 实现方（`ticket-recovery-service.ts`）的三种结论都携带 `operation`，结构上即满足本端口。未注入实现时
 * `getOperation` 退回 T02 行为（原样返回账本行），因此 T02 的调用方与测试不受影响。
 */
export interface TicketOperationRecoveryPort {
  reconcile(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly operationId: string;
  }): Promise<{ readonly operation: TicketOperationRow }>;
}

/** 需要核对的状态（§8.1）：`dispatching` 是崩溃/在途残留，`uncertain` 是结果未定；终态一律不触发。 */

export interface TicketFacadeDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 只用于展示名解析，绝不参与授权判定（`identity-directory.ts` 的契约边界）。 */
  readonly identity: IdentityDirectory;
  /** 工单领域服务（无授权判断）；由组合根构造，Facade 不接触仓储。 */
  readonly service: TicketService;
  /** 工单修改与标签挂载的领域编排（回源核对版本、写远端、刷索引）。 */
  readonly edit: TicketEditService;
  /** 项目领域服务：读写工单前先解析出可见项目（授权条件由本层传入）。 */
  readonly projects: TicketProjectService;
  /** 操作账本：`getOperation` 的可见性判定（决策 D5）。 */
  readonly operations: TicketOperationService;
  /** 恢复核对（T03 §8.1）：缺省不装配，`getOperation` 即保持 T02 的「只读账本」语义。 */
  readonly recovery?: TicketOperationRecoveryPort;
}

class TicketFacade extends AuthorizedResourceFacade implements TicketFacadeApi {
  private readonly identity: IdentityDirectory;
  private readonly projects: TicketProjectService;
  private readonly operations: TicketOperationService;
  private readonly service: TicketService;
  private readonly edit: TicketEditService;
  private readonly recovery: TicketOperationRecoveryPort | undefined;

  constructor(options: AuthorizedResourceFacadeOptions, deps: TicketFacadeDeps) {
    super(options);
    this.identity = deps.identity;
    this.projects = deps.projects;
    this.operations = deps.operations;
    this.service = deps.service;
    this.edit = deps.edit;
    this.recovery = deps.recovery;
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
    // 两次无关的凭据读取并行：展示名解析（身份目录）与在途变更查询（账本）互不依赖。
    const [displayNames, pendingOperationId] = await Promise.all([
      this.resolveDisplayNames(collectFactsActorIds(facts)),
      this.findPendingOperationId(project.id, issueNumber),
    ]);
    return toTicketDetailView(facts, displayNames, pendingOperationId);
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
    const authorName = await this.resolveActorName(actor);
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
      // 刚创建的工单不可能有在途变更：账本行在返回前已是成功终态。
      ticket: toTicketDetailView(
        outcome.facts,
        await this.resolveDisplayNames(collectFactsActorIds(outcome.facts)),
        null,
      ),
      operationId: outcome.operationId,
    };
  }

  async update(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: TicketUpdateInput,
    idempotencyKey: string,
  ): Promise<TicketEditOutcomeView> {
    const project = await this.requireWritableProject(actor, projectId);
    // 权限判定吃的是**回源后的归属事实**（作者来自 `ticket_messages` 而非请求体）：伪造身份头不会带来
    // 权限，外部来源（authorId === null）因此只有管理员能动（§2.2 / §3.1）。
    const facts = await this.service.getIssue({
      organizationId: project.organizationId,
      projectId: project.id,
      bindingId: project.repositoryRef,
      issueNumber,
    });
    await this.requireIssueEditPermission(
      actor,
      project.id,
      {
        authorId: facts.author.source === "aos" ? facts.author.authorId : null,
        assigneeId: facts.assigneeId,
      },
      {
        touchesContent: input.title !== undefined || input.body !== undefined,
        touchesStateOrAssignee: input.assigneeId !== undefined || input.state !== undefined,
      },
    );

    const outcome = await this.edit.updateIssue({
      organizationId: project.organizationId,
      projectId: project.id,
      bindingId: project.repositoryRef,
      issueNumber,
      actorId: actor.userId,
      actorName: await this.resolveActorName(actor),
      ...input,
      idempotencyKey,
    } satisfies TicketUpdateIssueInput);
    return await this.toEditOutcomeView(outcome);
  }

  async setLabels(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: { labelIds: readonly string[]; expectedVersion: string },
    idempotencyKey: string,
  ): Promise<TicketEditOutcomeView> {
    const project = await this.requireWritableProject(actor, projectId);
    const facts = await this.service.getIssue({
      organizationId: project.organizationId,
      projectId: project.id,
      bindingId: project.repositoryRef,
      issueNumber,
    });
    // 标签挂载与标题/描述同规则（裁定二.10）：创建者或管理员；负责人不因此获得权限。
    await this.requireAuthority(
      actor,
      project.id,
      (authority) =>
        canEditTicketContent(authority, { authorId: facts.author.source === "aos" ? facts.author.authorId : null }),
      "只有工单创建者或组织管理员可以修改标签",
    );

    const outcome = await this.edit.setLabels({
      organizationId: project.organizationId,
      projectId: project.id,
      bindingId: project.repositoryRef,
      issueNumber,
      actorId: actor.userId,
      labelIds: input.labelIds,
      expectedVersion: input.expectedVersion,
      idempotencyKey,
    } satisfies TicketLabelSetInput);
    return await this.toEditOutcomeView(outcome);
  }

  async getOperation(actor: ActorContext, operationId: string): Promise<TicketOperationView> {
    const organizationId = actor.activeOrganizationId;
    // 没有组织上下文就看不到任何账本行：与「不是本人」同形返回 404，不区分原因。
    if (organizationId === undefined) throw new OperationNotFoundError();
    const row = await this.operations.findForActor({ organizationId, actorId: actor.userId, operationId });
    if (row === undefined) throw new OperationNotFoundError();
    // §8.1：未定状态在返回前执行一次核对（只回源读取、绝不重放写入），核对结果直接作为响应——前端据此
    // 从「确认中」转到终态，不需要第二条路由。核对自身失败（上游不可用）按 503 上抛：宁可让客户端稍后重查，
    // 也不把一次读故障伪装成「仍在进行中」。
    if (this.recovery !== undefined && RECONCILABLE_OPERATION_STATUSES.has(row.status)) {
      const outcome = await this.recovery.reconcile({ organizationId, actorId: actor.userId, operationId });
      return toTicketOperationView(outcome.operation);
    }
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

  /**
   * 写路径的项目解析：在 {@link requireProject} 之上加暂停闸门。
   *
   * 暂停检查必须与「版本冲突」同层——都在领取之前、都不产生账本行（§5.1 步骤 2），否则一次 503 会烧掉
   * 用户的幂等键，同键重试再拿不到同一个答复。
   */
  private async requireWritableProject(actor: ActorContext, projectId: string): Promise<TicketProjectRow> {
    const project = await this.requireProject(actor, projectId);
    if (project.status === "paused") throw new TicketsPausedError();
    return project;
  }

  /**
   * 本次 PATCH 触及的字段各判各的规则（§2.1）：改标题/描述要「创建者或管理员」，改负责人/状态要
   * 「创建者、当前负责人或管理员」。混合请求因此可能两条都要过——不合并成一条更宽的规则，也不会
   * 因为「有一条通过」就放行另一条。
   */
  private async requireIssueEditPermission(
    actor: ActorContext,
    projectId: string,
    issue: { readonly authorId: string | null; readonly assigneeId: string | null },
    touched: { readonly touchesContent: boolean; readonly touchesStateOrAssignee: boolean },
  ): Promise<void> {
    if (touched.touchesContent) {
      await this.requireAuthority(
        actor,
        projectId,
        (authority) => canEditTicketContent(authority, issue),
        "只有工单创建者或组织管理员可以修改标题与描述",
      );
    }
    if (touched.touchesStateOrAssignee) {
      await this.requireAuthority(
        actor,
        projectId,
        (authority) => canChangeIssueStateOrAssignee(authority, issue),
        "只有工单创建者、当前负责人或组织管理员可以指派或变更状态",
      );
    }
  }

  /**
   * 组织管理员身份判定 + 动作规则的共用出口（§2.3）。
   *
   * 「管理员可做任何事」这条规则只存在于 `ticket-permission.ts` 的三条纯函数里；本方法只负责把
   * 管理员身份**取出来**（经 `AccessControlModule`，与 `begin` 的授权同源），因此规则改动不会漏到 Facade。
   */
  private async requireAuthority(
    actor: ActorContext,
    projectId: string,
    allowed: (authority: TicketAuthority) => boolean,
    message: string,
  ): Promise<void> {
    const isOrganizationAdmin = await isProjectAdmin({
      accessControl: this.options.accessControl,
      resource: this.options.resource,
      actor,
      action: "update",
      projectId,
    });
    if (!allowed({ actorId: actor.userId, isOrganizationAdmin })) throw new ForbiddenError(message);
  }

  /** 显示名当前值；查不到时退化为 actorId，保证身份头与归属快照的字段永远非空。 */
  private async resolveActorName(actor: ActorContext): Promise<string> {
    return (await this.identity.getUser(actor.userId))?.name ?? actor.userId;
  }

  /**
   * 该工单上未终结的修改操作（`issue.update` / `issue.labels`），没有则 `null`。
   *
   * 互斥组取自 `ISSUE_CHANGE_KINDS`，与写路径的在途互斥是同一组：评论、创建、标签 CRUD 不属于「同工单
   * 变更」，把它们算进来会让一次未确认的评论把整张工单的写入口锁死（§5.5）。
   */
  private async findPendingOperationId(projectId: string, issueNumber: string): Promise<string | null> {
    const operationId = await this.operations.findInFlightTarget({
      projectId,
      targetId: issueNumber,
      kinds: ISSUE_CHANGE_KINDS,
    });
    return operationId ?? null;
  }

  /** 修改类写结果 → 视图：成功时回读一次远端拼详情（§5.4 允许的只读重放），未定只给出 operationId。 */
  private async toEditOutcomeView(outcome: TicketEditOutcome): Promise<TicketEditOutcomeView> {
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
    return {
      kind: "updated",
      ticket: toTicketDetailView(
        outcome.facts,
        await this.resolveDisplayNames(collectFactsActorIds(outcome.facts)),
        null,
      ),
      operationId: outcome.operationId,
    };
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
