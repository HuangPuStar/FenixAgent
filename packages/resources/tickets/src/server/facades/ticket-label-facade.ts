/**
 * 项目标签 Facade：管理员判定与视图组装（backend contract §1.1 路由 6–8 / §2.1 / §7）。
 *
 * 标签的**事实源在托管平台**，本包不为它建表，因此这一层的职责只有三件事：解析可见项目（跨组织/不存在
 * → 404）、判定管理员动作（组织内成员 → 403）、把领域服务的事实投影成目录视图。
 *
 * 两条与工单路径不同的口径，都是刻意的：
 * 1. **列表只需项目 `read`**：标签目录是仓库级公开信息，成员看得到工单就应当看得到它的标签；
 * 2. **新建与改名不要求 `expectedVersion`**（裁定二.7）：上游没有标签版本字段，管理动作不参与工单的内容
 *    版本口径；但它仍是写路径，因此照样要 `Idempotency-Key`（管理员双击不该在仓库里留下两个同名标签）。
 *
 * 管理员判定经 `requireProjectAction`（§2.3 的共用收窄）：它只在授权拒绝时转 403，存储故障原样上抛，
 * 不会被伪装成权限问题。
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
import type { TicketLabelService, TicketLabelWriteOutcome } from "../services/ticket-label-service";
import type { TicketProjectService } from "../services/ticket-project-service";
import { requireProjectAction } from "./ticket-action-guard";
import { type TicketProjectLabelView, toTicketProjectLabelView } from "./ticket-view";

export type { TicketProjectLabelView } from "./ticket-view";

/** 写路径的统一结果：与工单/评论侧同形（202 只带 operationId）。 */
export type TicketLabelWriteOutcomeView =
  | { readonly kind: "written"; readonly label: TicketProjectLabelView; readonly operationId: string }
  | { readonly kind: "uncertain"; readonly operationId: string };

/** 标签的创建/修改入参；`undefined` = 不改（PATCH 语义，协议层已保证至少一项）。 */
export interface TicketLabelWriteInput {
  readonly name?: string;
  readonly color?: string;
  readonly description?: string;
}

export interface TicketLabelFacadeApi {
  /** 仓库标签集合；一次给全，**不翻页**（适配器已按 `Link` 头翻完）。 */
  list(actor: ActorContext, projectId: string): Promise<readonly TicketProjectLabelView[]>;
  create(
    actor: ActorContext,
    projectId: string,
    input: TicketLabelWriteInput & { readonly name: string },
    idempotencyKey: string,
  ): Promise<TicketLabelWriteOutcomeView>;
  update(
    actor: ActorContext,
    projectId: string,
    labelId: string,
    input: TicketLabelWriteInput,
    idempotencyKey: string,
  ): Promise<TicketLabelWriteOutcomeView>;
}

export interface TicketLabelFacadeDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 项目领域服务：写标签前先解析出可见项目（授权条件由本层传入）。 */
  readonly projects: TicketProjectService;
  /** 标签领域服务（无授权判断）。 */
  readonly labels: TicketLabelService;
}

class TicketLabelFacade extends AuthorizedResourceFacade implements TicketLabelFacadeApi {
  private readonly projects: TicketProjectService;
  private readonly labels: TicketLabelService;

  constructor(options: AuthorizedResourceFacadeOptions, deps: TicketLabelFacadeDeps) {
    super(options);
    this.projects = deps.projects;
    this.labels = deps.labels;
  }

  async list(actor: ActorContext, projectId: string): Promise<readonly TicketProjectLabelView[]> {
    const project = await this.requireProject(actor, projectId);
    const labels = await this.labels.listLabels(this.scopeOf(project));
    return labels.map(toTicketProjectLabelView);
  }

  async create(
    actor: ActorContext,
    projectId: string,
    input: TicketLabelWriteInput & { readonly name: string },
    idempotencyKey: string,
  ): Promise<TicketLabelWriteOutcomeView> {
    const project = await this.requireLabelAdmin(actor, projectId);
    const outcome = await this.labels.createLabel({
      ...this.scopeOf(project),
      actorId: actor.userId,
      name: input.name,
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.description === undefined ? {} : { description: input.description }),
      idempotencyKey,
    });
    return this.toWriteOutcomeView(outcome);
  }

  async update(
    actor: ActorContext,
    projectId: string,
    labelId: string,
    input: TicketLabelWriteInput,
    idempotencyKey: string,
  ): Promise<TicketLabelWriteOutcomeView> {
    const project = await this.requireLabelAdmin(actor, projectId);
    const outcome = await this.labels.updateLabel({
      ...this.scopeOf(project),
      labelId,
      actorId: actor.userId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.description === undefined ? {} : { description: input.description }),
      idempotencyKey,
    });
    return this.toWriteOutcomeView(outcome);
  }

  /** 解析可见项目；不存在、跨组织与「成员关系已移除」同形返回 404（与工单 Facade 同口径）。 */
  private async requireProject(actor: ActorContext, projectId: string): Promise<TicketProjectRow> {
    const access = await this.listConstraint(actor, "read");
    const project = await this.projects.findReadable({ access, projectId });
    if (project === undefined) throw new NotFoundError("工单项目不存在");
    return project;
  }

  /**
   * 标签写路径的闸门：先解析可见项目（404 优先于 403，跨组织不暴露「项目存在」），再判管理员动作，
   * 最后才看暂停——暂停是组织级状态，它的 503 只在主体确实有权写时才有意义。
   */
  private async requireLabelAdmin(actor: ActorContext, projectId: string): Promise<TicketProjectRow> {
    const project = await this.requireProject(actor, projectId);
    await requireProjectAction({
      accessControl: this.options.accessControl,
      resource: this.options.resource,
      actor,
      action: "update",
      projectId: project.id,
      message: "只有组织管理员可以管理项目标签",
    });
    if (project.status === "paused") throw new TicketsPausedError();
    return project;
  }

  /** 坐标取自已授权的项目行，绝不从请求体拼接。 */
  private scopeOf(project: TicketProjectRow) {
    return { organizationId: project.organizationId, projectId: project.id, bindingId: project.repositoryRef };
  }

  /**
   * 写结果 → 视图。
   *
   * 与工单/评论不同，这里**没有**成功后的远端回读：标签 CRUD 的响应就是上游这一次写入的投影
   * （`TicketLabelFacts` 由服务端从 `labels.create/edit` 的返回值构造），重放的读取同样在领域服务里。
   */
  private toWriteOutcomeView(outcome: TicketLabelWriteOutcome): TicketLabelWriteOutcomeView {
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
    return { kind: "written", label: toTicketProjectLabelView(outcome.label), operationId: outcome.operationId };
  }
}

/** 构造标签 Facade；只构造不读 DB、不写单例，测试可注入替身（§4.1）。 */
export function createTicketLabelFacade(deps: TicketLabelFacadeDeps): TicketLabelFacadeApi {
  return new TicketLabelFacade(
    {
      accessControl: deps.accessControl,
      resource: ticketProjectResource.definition,
      scopeStore: deps.scopeStore,
    },
    deps,
  );
}
