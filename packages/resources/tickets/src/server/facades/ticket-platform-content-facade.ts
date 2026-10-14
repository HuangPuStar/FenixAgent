/**
 * 平台管理面的**周边资源** Facade（`/api/system/tickets/:projectId/**`）：评论、附件、标签目录与可指派成员。
 *
 * 与 `ticket-platform-facade.ts`（工单本体）分开只为一件事：一个文件里同时放「工单本体的写编排」与「四类
 * 周边资源的读写」会超过可读的规模，而它们的判据与编排又完全是同一套。两份文件共用
 * `ticket-platform-context.ts` 的项目坐标解析与审计主体，因此规则仍只有一份。
 *
 * 与 `/web` 面的镜像关系（`docs/arch/29-tickets.md` §12）：同名操作、同一批 zod schema、同一份视图类型。
 * 业务规则一条不改——评论的作者归属核验、附件的一次一文件与大小上限、标签的全量集合语义、成员的收窄投影
 * （只有 `userId` 与 `name`，PII 不出这条路径）全部复用同一批领域服务与视图映射。
 *
 * 与 `/web` 面的两处**有意差异**：
 *
 * 1. **没有角色判定**：「只有原作者或管理员可以改这条评论」「只有组织管理员可以管理标签」这类规则不适用于
 *    平台凭据（凭据即判据）。因此评论编辑在这里少了 `canEditComment` 那一步，标签目录在这里是只读的
 *    （新建与改名是组织内的目录管理动作，不属于「工单页面等价能力」，见 §12 的未镜像清单）。
 * 2. **审计主体是系统托管租户（平台系统管理员）**：发表评论时 `author.id` 与归属行写的是系统租户用户，而
 *    不是某个组织成员；**编辑**评论时账本的发起人与归属行的 `last_editor_id` 同样记它，而作者不转移
 *    （身份头与 `author_id` 沿用归属行里的原始作者，§3.5）。核验口径不变（身份头 + 归属行 + 摘要 + 组织
 *    四处吻合才算 AOS 作者），因此这条评论在控制台里显示为该系统用户，且**不会**因为「作者不是组织成员」
 *    而失去归属。谁可以编辑、记成什么主体，见 §12。
 */

import type { TicketProjectRow } from "../repositories/ticket-projects";
import type { TicketAttachmentFacts, TicketAttachmentWriteOutcome } from "../services/ticket-attachment-service";
import type { TicketCommentFacts, TicketCommentWriteOutcome } from "../services/ticket-comment-service";
import type { TicketLabelFacts } from "../services/ticket-label-service";
import type { TicketAttachmentDownloadView, TicketAttachmentWriteOutcomeView } from "./ticket-attachment-facade";
import type { TicketCommentPageView, TicketCommentView, TicketCommentWriteOutcomeView } from "./ticket-comment-facade";
import { type TicketPlatformContext, type TicketPlatformFacadeDeps, ticketScopeOf } from "./ticket-platform-context";
import {
  collectCommentActorIds,
  type TicketAttachmentView,
  type TicketMemberPageView,
  type TicketProjectLabelView,
  toTicketAttachmentView,
  toTicketCommentView,
  toTicketMemberView,
  toTicketProjectLabelView,
} from "./ticket-view";

/** 管理面的周边资源入口；由 `TicketPlatformFacadeApi` 继承，对调用方与工单本体同属一个门面。 */
export interface TicketPlatformContentApi {
  /** 评论列表：回源托管平台且按时间倒序（首屏最新一页），游标语义与 `/web` 面逐字相同。 */
  listComments(
    projectId: string,
    issueNumber: string,
    query: { readonly cursor?: string; readonly limit: number },
  ): Promise<TicketCommentPageView>;
  /** 发表评论：作者取平台审计主体（请求体不含作者字段）。 */
  createComment(
    projectId: string,
    issueNumber: string,
    input: { readonly body: string },
    idempotencyKey: string,
  ): Promise<TicketCommentWriteOutcomeView>;
  /**
   * 修改评论：仅比对内容指纹（`expectedVersion`）。
   *
   * 「原作者或组织管理员可改」这条规则在管理面**不适用**（判据是凭据）；编辑主体记成平台审计主体，作者
   * 不转移（见文件头第 2 条与 `docs/arch/29-tickets.md` §12.2 的「评论编辑的主体与规则」）。
   */
  updateComment(
    projectId: string,
    issueNumber: string,
    commentId: string,
    input: { readonly body: string; readonly expectedVersion: string },
    idempotencyKey: string,
  ): Promise<TicketCommentWriteOutcomeView>;
  /** 该工单的附件列表（回源托管平台；上游不可用报 503，**绝不**退化成空列表）。 */
  listAttachments(projectId: string, issueNumber: string): Promise<{ readonly items: TicketAttachmentView[] }>;
  /** 上传单个附件（multipart 的形状与上限由路由与附件协议模块把住）。 */
  uploadAttachment(
    projectId: string,
    issueNumber: string,
    input: { readonly name: string; readonly content: Uint8Array; readonly contentType?: string },
    idempotencyKey: string,
  ): Promise<TicketAttachmentWriteOutcomeView>;
  /** 下载附件：字节流穿过本层，不改写、不缓冲。 */
  downloadAttachment(
    projectId: string,
    issueNumber: string,
    attachmentId: string,
  ): Promise<TicketAttachmentDownloadView>;
  /** 仓库标签目录（不翻页：标签是仓库级小集合）；只读，见文件头的差异说明。 */
  listLabels(projectId: string): Promise<readonly TicketProjectLabelView[]>;
  /** 可指派成员候选（工单负责人下拉的数据源）：按**项目所属组织**分页查询，只回 `userId` 与 `name`。 */
  listMembers(
    projectId: string,
    query: { readonly q?: string; readonly page: number; readonly pageSize: number },
  ): Promise<TicketMemberPageView>;
}

/** 构造周边资源入口；由 `createTicketPlatformFacade` 组装进同一个门面。 */
export function createTicketPlatformContent(
  deps: TicketPlatformFacadeDeps,
  context: TicketPlatformContext,
): TicketPlatformContentApi {
  /** 评论事实 → 视图：展示名一次批量解析（列表也走这里，N 条评论只有 1 次身份目录查询）。 */
  async function toCommentViews(facts: readonly TicketCommentFacts[]): Promise<TicketCommentView[]> {
    const displayNames = await context.displayNames(collectCommentActorIds(facts));
    return facts.map((item) => toTicketCommentView(item, displayNames));
  }

  /** 评论写结果 → 视图：与 `/web` 面同形（202 只带 operationId），前端复用同一个判别函数。 */
  async function toCommentWriteOutcome(outcome: TicketCommentWriteOutcome): Promise<TicketCommentWriteOutcomeView> {
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
    const [comment] = await toCommentViews([outcome.facts]);
    // 单条评论必然映射出一条视图；`undefined` 只可能是视图层被判空，属编程错误，不得静默降级成空评论。
    if (comment === undefined) throw new Error("评论写结果映射后为空：视图组装与写结果类型已不一致");
    return { kind: "written", comment, operationId: outcome.operationId };
  }

  /** 附件写结果 → 视图：附件没有本地行也没有作者，成功分支就是一次字段搬运（与 `/web` 面同形）。 */
  function toAttachmentWriteOutcome(outcome: TicketAttachmentWriteOutcome): TicketAttachmentWriteOutcomeView {
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
    return {
      kind: "written",
      attachment: toTicketAttachmentView(outcome.attachment),
      operationId: outcome.operationId,
    };
  }

  /** 附件事实 → 视图（列表专用的小映射，避免在闭包里再写一遍字段搬运）。 */
  function toAttachmentViews(facts: readonly TicketAttachmentFacts[]): TicketAttachmentView[] {
    return facts.map(toTicketAttachmentView);
  }

  /** 标签事实 → 视图：目录项比工单视图多一个 `description`（映射口径见 `ticket-view.ts`）。 */
  function toLabelViews(facts: readonly TicketLabelFacts[]): TicketProjectLabelView[] {
    return facts.map(toTicketProjectLabelView);
  }

  /** 成员候选：组织取自项目行（不是调用方的组织），与 `/web` 面同一条理由。 */
  async function listMembersForProject(
    project: TicketProjectRow,
    query: { readonly q?: string; readonly page: number; readonly pageSize: number },
  ): Promise<TicketMemberPageView> {
    const page = await deps.identity.listOrganizationMembers({
      organizationId: project.organizationId,
      ...(query.q === undefined ? {} : { keyword: query.q }),
      page: query.page,
      pageSize: query.pageSize,
    });
    // 白名单搬运（`toTicketMemberView`）而不是直接展开身份目录的返回值：投影将来加字段也不会自动外泄。
    return { items: page.items.map(toTicketMemberView), total: page.total };
  }

  return {
    async listComments(projectId, issueNumber, query) {
      const project = await context.requireProject(projectId);
      const page = await deps.comments.listPage({
        ...ticketScopeOf(project, issueNumber),
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      return { items: await toCommentViews(page.items), nextCursor: page.nextCursor };
    },

    async createComment(projectId, issueNumber, input, idempotencyKey) {
      const project = await context.requireWritableProject(projectId);
      const actor = await context.auditActor();
      const outcome = await deps.comments.createComment({
        ...ticketScopeOf(project, issueNumber),
        actorId: actor.actorId,
        actorName: actor.actorName,
        body: input.body,
        idempotencyKey,
      });
      return await toCommentWriteOutcome(outcome);
    },

    async updateComment(projectId, issueNumber, commentId, input, idempotencyKey) {
      const project = await context.requireWritableProject(projectId);
      const actor = await context.auditActor();
      const outcome = await deps.comments.updateComment({
        ...ticketScopeOf(project, issueNumber),
        commentId,
        actorId: actor.actorId,
        actorName: actor.actorName,
        body: input.body,
        expectedVersion: input.expectedVersion,
        idempotencyKey,
      });
      return await toCommentWriteOutcome(outcome);
    },

    async listAttachments(projectId, issueNumber) {
      const project = await context.requireProject(projectId);
      return { items: toAttachmentViews(await deps.attachments.listAttachments(ticketScopeOf(project, issueNumber))) };
    },

    async uploadAttachment(projectId, issueNumber, input, idempotencyKey) {
      const project = await context.requireWritableProject(projectId);
      const actor = await context.auditActor();
      const outcome = await deps.attachments.uploadAttachment({
        ...ticketScopeOf(project, issueNumber),
        actorId: actor.actorId,
        name: input.name,
        content: input.content,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        idempotencyKey,
      });
      return toAttachmentWriteOutcome(outcome);
    },

    async downloadAttachment(projectId, issueNumber, attachmentId) {
      const project = await context.requireProject(projectId);
      const download = await deps.attachments.downloadAttachment({
        ...ticketScopeOf(project, issueNumber),
        attachmentId,
      });
      return {
        attachment: toTicketAttachmentView(download.attachment),
        contentType: download.contentType,
        contentLength: download.contentLength,
        stream: download.stream,
      };
    },

    async listLabels(projectId) {
      const project = await context.requireProject(projectId);
      return toLabelViews(
        await deps.labels.listLabels({
          organizationId: project.organizationId,
          projectId: project.id,
          bindingId: project.repositoryRef,
        }),
      );
    },

    async listMembers(projectId, query) {
      const project = await context.requireProject(projectId);
      return await listMembersForProject(project, query);
    },
  };
}
