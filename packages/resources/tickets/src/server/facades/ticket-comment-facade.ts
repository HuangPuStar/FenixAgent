/**
 * 评论 Facade：项目解析、权限判定与视图组装（backend contract §1.1 路由 1–3 / §2.1 / §3.2）。
 *
 * `route → Facade → Domain Service → Repository` 里的授权层：route 只做协议适配，领域服务不认识 actor。
 * **「谁能评论、谁能编辑这条评论」只在这里判定**：
 * - 项目可见性与不存在/跨组织由受控读取收敛成同一个 404（与工单 Facade 同口径）；
 * - 「原作者或管理员可编辑评论」（§2.1）经 `ticket-permission.canEditComment` 判定，管理员身份由
 *   `AccessControlModule` 现取（与写路径在途互斥所用的是同一套授权）；
 * - 作者归属只从**回源正文 + `ticket_messages` 归属行**核验得出（`TicketCommentFacts.author`），
 *   请求体里的任何身份字段都不参与判定——这正是「不得按自填 user_id 授予编辑权」的落点（§3.1）。
 *
 * 倒序分页（裁定三.14）不在本层实现：Facade 原样透传 `cursor` / `limit`，机制与退化点见
 * `ticket-comment-page.ts`（首屏探末页、逐页递减，绝不整串扫描）。
 *
 * 暂停语义（T02 口径）：项目 `paused` 时评论写路径报 503 且**不产生任何上游调用**，列表照常可用。
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
} from "@fenix/platform-sdk";
import { ticketProjectResource } from "../access/ticket-project-resource";
import { TicketsPausedError } from "../errors";
import type { TicketProjectRow } from "../repositories/ticket-projects";
import type {
  TicketCommentFacts,
  TicketCommentService,
  TicketCommentWriteOutcome,
} from "../services/ticket-comment-service";
import { canEditComment, type TicketAuthority } from "../services/ticket-permission";
import type { TicketProjectService } from "../services/ticket-project-service";
import { isProjectAdmin } from "./ticket-action-guard";
import {
  collectCommentActorIds,
  type DisplayNames,
  type TicketCommentPageView,
  type TicketCommentView,
  toTicketCommentView,
} from "./ticket-view";

export type { TicketCommentPageView, TicketCommentView } from "./ticket-view";

/** 写路径的统一结果：与工单侧同形（202 只带 operationId），前端复用同一个判别函数。 */
export type TicketCommentWriteOutcomeView =
  | { readonly kind: "written"; readonly comment: TicketCommentView; readonly operationId: string }
  | { readonly kind: "uncertain"; readonly operationId: string };

export interface TicketCommentFacadeApi {
  /** 评论列表：回源托管平台（上游不可用报 503，**绝不**退化成空列表）。 */
  list(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    query: { readonly cursor?: string; readonly limit: number },
  ): Promise<TicketCommentPageView>;
  create(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: { readonly body: string },
    idempotencyKey: string,
  ): Promise<TicketCommentWriteOutcomeView>;
  update(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    commentId: string,
    input: { readonly body: string; readonly expectedVersion: string },
    idempotencyKey: string,
  ): Promise<TicketCommentWriteOutcomeView>;
}

export interface TicketCommentFacadeDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 只用于展示名解析，绝不参与授权判定（`identity-directory.ts` 的契约边界）。 */
  readonly identity: IdentityDirectory;
  /** 项目领域服务：读评论前先解析出可见项目（授权条件由本层传入）。 */
  readonly projects: TicketProjectService;
  /** 评论领域服务（无授权判断）；版本冲突与作者核验都在它内部完成。 */
  readonly comments: TicketCommentService;
}

class TicketCommentFacade extends AuthorizedResourceFacade implements TicketCommentFacadeApi {
  private readonly identity: IdentityDirectory;
  private readonly projects: TicketProjectService;
  private readonly comments: TicketCommentService;

  constructor(options: AuthorizedResourceFacadeOptions, deps: TicketCommentFacadeDeps) {
    super(options);
    this.identity = deps.identity;
    this.projects = deps.projects;
    this.comments = deps.comments;
  }

  async list(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    query: { readonly cursor?: string; readonly limit: number },
  ): Promise<TicketCommentPageView> {
    const project = await this.requireProject(actor, projectId);
    const page = await this.comments.listPage({
      ...this.scopeOf(project, issueNumber),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const displayNames = await this.resolveDisplayNames(collectCommentActorIds(page.items));
    return { items: page.items.map((item) => toTicketCommentView(item, displayNames)), nextCursor: page.nextCursor };
  }

  async create(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: { readonly body: string },
    idempotencyKey: string,
  ): Promise<TicketCommentWriteOutcomeView> {
    const project = await this.requireWritableProject(actor, projectId);
    // 同组织成员即可评论（项目 `read` 就是这条规则的全部），不再叠加对象级判定：工单本体不是受控资源行。
    const outcome = await this.comments.createComment({
      ...this.scopeOf(project, issueNumber),
      actorId: actor.userId,
      actorName: await this.resolveActorName(actor),
      body: input.body,
      idempotencyKey,
    });
    return await this.toWriteOutcomeView(outcome);
  }

  async update(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    commentId: string,
    input: { readonly body: string; readonly expectedVersion: string },
    idempotencyKey: string,
  ): Promise<TicketCommentWriteOutcomeView> {
    const project = await this.requireWritableProject(actor, projectId);
    const scope = this.scopeOf(project, issueNumber);
    // 编辑前先取回该评论的当前事实：它同时完成两件事——「评论确属该工单」（不属于 → 404，与不存在同形）
    // 与「作者归属核验」（回源正文与归属行同时吻合才算 AOS 作者）。
    const current = await this.comments.getComment({ ...scope, commentId });
    await this.requireCommentEdit(actor, project.id, current);
    const outcome = await this.comments.updateComment({
      ...scope,
      commentId,
      actorId: actor.userId,
      actorName: await this.resolveActorName(actor),
      body: input.body,
      expectedVersion: input.expectedVersion,
      idempotencyKey,
    });
    return await this.toWriteOutcomeView(outcome);
  }

  /**
   * 评论编辑权限：原作者或管理员（§2.1）。判定吃 `TicketCommentFacts.author`——它只可能来自核验结论，
   * `source === "external"` 时 `authorId` 恒为 `null`，因此外部来源评论对非管理员一律拒绝（§3.2）。
   */
  private async requireCommentEdit(actor: ActorContext, projectId: string, comment: TicketCommentFacts): Promise<void> {
    const isOrganizationAdmin = await isProjectAdmin({
      accessControl: this.options.accessControl,
      resource: this.options.resource,
      actor,
      action: "update",
      projectId,
    });
    const authority: TicketAuthority = { actorId: actor.userId, isOrganizationAdmin };
    const authorId = comment.author.source === "aos" ? comment.author.authorId : null;
    if (!canEditComment(authority, { authorId })) {
      throw new ForbiddenError("只有评论原作者或组织管理员可以修改该评论");
    }
  }

  /**
   * 解析可见项目；不存在、跨组织与「成员关系已移除」同形返回 404。
   *
   * 与工单 Facade 的 `requireProject` 是同一段逻辑的两份实现（两处各 5 行），不抽公共函数的原因：两者
   * 分属不同的 Facade 实例，抽出去会把「项目可见性判定」变成一处需要跨文件理解的隐式契约；重复的是对
   * 平台受控查询的一次调用，不是规则本身。
   */
  private async requireProject(actor: ActorContext, projectId: string): Promise<TicketProjectRow> {
    const access = await this.listConstraint(actor, "read");
    const project = await this.projects.findReadable({ access, projectId });
    if (project === undefined) throw new NotFoundError("工单项目不存在");
    return project;
  }

  /** 写路径的项目解析：暂停闸门在领取之前（与版本冲突同层），一次 503 不烧掉幂等键。 */
  private async requireWritableProject(actor: ActorContext, projectId: string): Promise<TicketProjectRow> {
    const project = await this.requireProject(actor, projectId);
    if (project.status === "paused") throw new TicketsPausedError();
    return project;
  }

  /** 三个坐标一律取自已授权的项目行与路径参数，绝不从请求体拼接。 */
  private scopeOf(project: TicketProjectRow, issueNumber: string) {
    return {
      organizationId: project.organizationId,
      projectId: project.id,
      bindingId: project.repositoryRef,
      issueNumber,
    };
  }

  /** 显示名当前值；查不到时退化为 actorId，保证身份头与归属快照的字段永远非空。 */
  private async resolveActorName(actor: ActorContext): Promise<string> {
    return (await this.identity.getUser(actor.userId))?.name ?? actor.userId;
  }

  /** 一次批量解析本请求会展示到的 AOS 主体；空集合不发查询。 */
  private async resolveDisplayNames(userIds: readonly string[]): Promise<DisplayNames> {
    if (userIds.length === 0) return new Map();
    return this.identity.listUserDisplayInfo(userIds);
  }

  /**
   * 写结果 → 视图：成功时用**服务端返回的事实**组装（`version` 从那里来），未定只给 `operationId`。
   *
   * 成功分支允许一次远端读取（评论创建后回读拼视图）是 §5.4 的口径：远端写入绝不重放，重放的读取挂在
   * 领域服务里，本层只做投影。
   */
  private async toWriteOutcomeView(outcome: TicketCommentWriteOutcome): Promise<TicketCommentWriteOutcomeView> {
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
    const displayNames = await this.resolveDisplayNames(collectCommentActorIds([outcome.facts]));
    return {
      kind: "written",
      comment: toTicketCommentView(outcome.facts, displayNames),
      operationId: outcome.operationId,
    };
  }
}

/** 构造评论 Facade；只构造不读 DB、不写单例，测试可注入替身（§4.1）。 */
export function createTicketCommentFacade(deps: TicketCommentFacadeDeps): TicketCommentFacadeApi {
  return new TicketCommentFacade(
    {
      accessControl: deps.accessControl,
      resource: ticketProjectResource.definition,
      scopeStore: deps.scopeStore,
    },
    deps,
  );
}
