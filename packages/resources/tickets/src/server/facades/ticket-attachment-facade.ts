/**
 * 附件 Facade：项目解析、权限判定与视图组装（T05）。
 *
 * `route → Facade → Domain Service` 里的授权层，与评论/标签 Facade 同形：
 * - 项目可见性与不存在/跨组织由受控读取收敛成同一个 404；
 * - 读（列表、下载）只要求项目可见；写（上传）额外要求项目未暂停（§9.1 的暂停语义：读仍可用）；
 * - **归属校验在领域服务侧完成**（附件编号在该工单的元数据端点下读取，不属于此工单即上游 404），
 *   本层不比对任何字段——「这个附件属于这个工单吗」没有第二套判据。
 *
 * 下载流在这里**只是穿过**：Facade 不缓冲、不改写字节，路由拿到 `stream` 直接交给响应（上游内容超时
 * 覆盖整条流，中途取消由浏览器断开连接触发，适配器据此归还并发名额）。
 */

import {
  type AccessControlModule,
  type ActorContext,
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  NotFoundError,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { ticketProjectResource } from "../access/ticket-project-resource";
import { TicketsPausedError } from "../errors";
import type { TicketProjectRow } from "../repositories/ticket-projects";
import type { TicketAttachmentService, TicketAttachmentWriteOutcome } from "../services/ticket-attachment-service";
import type { TicketProjectService } from "../services/ticket-project-service";
import { type TicketAttachmentView, toTicketAttachmentView } from "./ticket-view";

export type { TicketAttachmentView } from "./ticket-view";

/** 写路径的统一结果：与工单/评论同形（202 只带 operationId），前端复用同一个判别函数。 */
export type TicketAttachmentWriteOutcomeView =
  | { readonly kind: "written"; readonly attachment: TicketAttachmentView; readonly operationId: string }
  | { readonly kind: "uncertain"; readonly operationId: string };

/** 下载结果：视图 + 上游内容流；`contentType` / `contentLength` 可能缺失（上游可以不给）。 */
export interface TicketAttachmentDownloadView {
  readonly attachment: TicketAttachmentView;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly stream: ReadableStream<Uint8Array>;
}

export interface TicketAttachmentFacadeApi {
  /** 该工单的附件列表：回源托管平台（上游不可用报 503，**绝不**退化成空列表）。 */
  list(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
  ): Promise<{ readonly items: TicketAttachmentView[] }>;
  upload(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: { readonly name: string; readonly content: Uint8Array; readonly contentType?: string },
    idempotencyKey: string,
  ): Promise<TicketAttachmentWriteOutcomeView>;
  download(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    attachmentId: string,
  ): Promise<TicketAttachmentDownloadView>;
}

export interface TicketAttachmentFacadeDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 项目领域服务：读写附件前先解析出可见项目（授权条件由本层传入）。 */
  readonly projects: TicketProjectService;
  /** 附件领域服务（无授权判断）；归属校验与账本流转都在它内部完成。 */
  readonly attachments: TicketAttachmentService;
}

class TicketAttachmentFacade extends AuthorizedResourceFacade implements TicketAttachmentFacadeApi {
  private readonly projects: TicketProjectService;
  private readonly attachments: TicketAttachmentService;

  constructor(options: AuthorizedResourceFacadeOptions, deps: TicketAttachmentFacadeDeps) {
    super(options);
    this.projects = deps.projects;
    this.attachments = deps.attachments;
  }

  async list(actor: ActorContext, projectId: string, issueNumber: string) {
    const project = await this.requireProject(actor, projectId);
    const facts = await this.attachments.listAttachments(this.scopeOf(project, issueNumber));
    return { items: facts.map(toTicketAttachmentView) };
  }

  async upload(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    input: { readonly name: string; readonly content: Uint8Array; readonly contentType?: string },
    idempotencyKey: string,
  ): Promise<TicketAttachmentWriteOutcomeView> {
    const project = await this.requireWritableProject(actor, projectId);
    const outcome = await this.attachments.uploadAttachment({
      ...this.scopeOf(project, issueNumber),
      actorId: actor.userId,
      name: input.name,
      content: input.content,
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      idempotencyKey,
    });
    return toWriteOutcomeView(outcome);
  }

  async download(
    actor: ActorContext,
    projectId: string,
    issueNumber: string,
    attachmentId: string,
  ): Promise<TicketAttachmentDownloadView> {
    const project = await this.requireProject(actor, projectId);
    const download = await this.attachments.downloadAttachment({
      ...this.scopeOf(project, issueNumber),
      attachmentId,
    });
    return {
      attachment: toTicketAttachmentView(download.attachment),
      contentType: download.contentType,
      contentLength: download.contentLength,
      stream: download.stream,
    };
  }

  /** 解析可见项目；不存在、跨组织与「成员关系已移除」同形返回 404（与其它 Facade 同口径）。 */
  private async requireProject(actor: ActorContext, projectId: string): Promise<TicketProjectRow> {
    const access = await this.listConstraint(actor, "read");
    const project = await this.projects.findReadable({ access, projectId });
    if (project === undefined) throw new NotFoundError("工单项目不存在");
    return project;
  }

  /** 写路径的项目解析：暂停闸门在领取之前（与评论同层），一次 503 不烧掉幂等键。 */
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
}

/** 写结果 → 视图：附件没有本地行也没有作者，成功分支就是一次字段搬运。 */
function toWriteOutcomeView(outcome: TicketAttachmentWriteOutcome): TicketAttachmentWriteOutcomeView {
  if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
  return {
    kind: "written",
    attachment: toTicketAttachmentView(outcome.attachment),
    operationId: outcome.operationId,
  };
}

/** 构造附件 Facade；只构造不读 DB、不写单例，测试可注入替身（§4.1）。 */
export function createTicketAttachmentFacade(deps: TicketAttachmentFacadeDeps): TicketAttachmentFacadeApi {
  return new TicketAttachmentFacade(
    {
      accessControl: deps.accessControl,
      resource: ticketProjectResource.definition,
      scopeStore: deps.scopeStore,
    },
    deps,
  );
}
