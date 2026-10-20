/**
 * 工单项目的应用 Facade：授权判定 + 协议视图组装 + 开通编排（backend contract §4.3 / §5.2 / §6）。
 *
 * 它是项目资源的唯一应用入口（`route → Facade → Domain Service → Repository`）：route 只做协议接入与
 * 状态码映射，领域服务不认识 actor。**组织范围与角色判定只在这里发生**，全部经 `AccessControlModule`
 * （基类的 `listConstraint` / `resolveInitialScope` / `authorizeAction`），本文件不复制任何组织、角色
 * 或归属判断，也不直接接触仓储。
 *
 * 三处判定的落点（§5.2 的 404/403 唯一实现处）：
 * - **跨组织与不存在同形（404）**：读取一律经 `listConstraint(actor,"read")`，谓词由平台编译，只匹配
 *   actor 当前组织且要求其成员关系仍然成立（`build-predicate.ts:40-51`），别人的组织行根本不进结果集；
 * - **组织内成员的管理动作（403）**：`create`（开通）走 `resolveInitialScope`、`update`（切换/暂停）走
 *   `authorizeAction`，两者对 member 都不授予目标动作，平台抛 `ResourceAccessDeniedError`，这里转成
 *   对外 403——它是**权限拒绝**，不是「资源不存在」，两者不得合并；
 * - **暂停语义**：`paused` 只停写（工单创建在工单 Facade 里报 503），项目本身的读与状态变更仍可用，
 *   因此「把暂停中的项目设为默认」是状态冲突（409）而不是权限或存在性问题。
 *
 * 与合同 §4.3 的一处差异：`TicketProvisionOutcome` 的 `ok` 分支多带一条 `operation` 视图。§9.1 路由 2 的
 * 200 载荷是 `{project, operation}`，而 §9.3 要求路由不做业务判断——若由路由自己再查一次账本，载荷组装
 * 就漏回了协议层；多带一个字段对按 §4.3 写的调用方是无害的（多余字段不会被读取）。
 */

import {
  type AccessControlModule,
  type ActorContext,
  AuthorizedResourceFacade,
  type AuthorizedResourceFacadeOptions,
  ConflictError,
  type IdentityDirectory,
  NotFoundError,
  type ResourceAction,
  type ResourceQueryConstraint,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { ticketProjectResource } from "../access/ticket-project-resource";
import type { TicketProjectRow } from "../repositories/ticket-projects";
import type { TicketOperationService } from "../services/ticket-operation-service";
import type { TicketProjectService } from "../services/ticket-project-service";
import { runTicketAuthorized } from "./ticket-action-guard";
import {
  type TicketMemberPageView,
  type TicketOperationView,
  toTicketMemberView,
  toTicketOperationView,
} from "./ticket-view";

export interface TicketProjectView {
  readonly id: string;
  readonly organizationId: string;
  /** 仓库绑定 ID（= `ticket_projects.repository_ref`）。 */
  readonly bindingId: string;
  readonly repository: {
    readonly connectionId: string;
    readonly providerRepositoryId: string;
    readonly owner: string;
    readonly name: string;
  };
  readonly isDefault: boolean;
  readonly status: "active" | "paused";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TicketProjectOverview {
  readonly projects: readonly TicketProjectView[];
  readonly defaultProjectId: string | null;
  /** 组织级三态：`unconfigured` 无项目、`ready` 有可用默认项目、`paused` 有项目但无可用默认项目。 */
  readonly state: "unconfigured" | "ready" | "paused";
}

export type TicketProvisionInput =
  | {
      readonly connectionId: string;
      readonly mode: "create";
      readonly repository: { readonly owner: string; readonly name?: string };
    }
  | {
      readonly connectionId: string;
      readonly mode: "bind";
      readonly repository: { readonly owner: string; readonly name: string };
    };

export type TicketProvisionOutcome =
  | {
      readonly kind: "ok";
      readonly project: TicketProjectView;
      readonly operationId: string;
      readonly operation: TicketOperationView;
    }
  | { readonly kind: "uncertain"; readonly operationId: string };

export interface TicketProjectFacadeApi {
  list(actor: ActorContext): Promise<TicketProjectOverview>;
  provisionDefault(
    actor: ActorContext,
    input: TicketProvisionInput,
    idempotencyKey: string,
  ): Promise<TicketProvisionOutcome>;
  setDefault(
    actor: ActorContext,
    input: { projectId?: string; status?: "active" | "paused" },
  ): Promise<TicketProjectOverview>;
  /**
   * 可指派成员候选（分页 + 姓名关键词）。
   *
   * 只需项目 `read`：候选人是组织成员的公开投影，用于表单下拉，不构成管理动作。返回值**只有**
   * `{ userId, name }`（裁定二.6）——身份目录里带 email / 手机号 / 账号状态的读取路径不从这里经过。
   */
  listMembers(
    actor: ActorContext,
    projectId: string,
    query: { readonly q?: string; readonly page: number; readonly pageSize: number },
  ): Promise<TicketMemberPageView>;
}

export interface TicketProjectFacadeDeps {
  readonly accessControl: AccessControlModule;
  readonly scopeStore: ResourceScopeStore;
  /** 项目领域服务（无授权判断）；同一实例同时被工单 Facade 复用。 */
  readonly projects: TicketProjectService;
  readonly operations: TicketOperationService;
  /** 成员候选的投影来源；只读 `listOrganizationMembers`（收窄到 ID 与姓名），不参与授权判定。 */
  readonly identity: IdentityDirectory;
}

/** 项目行 → 协议视图；`repository` 是开通时写入的坐标快照（展示与排障用，不参与授权）。 */
function toProjectView(row: TicketProjectRow): TicketProjectView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    bindingId: row.repositoryRef,
    repository: {
      connectionId: row.connectionId,
      providerRepositoryId: row.providerRepositoryId,
      owner: row.owner,
      name: row.name,
    },
    isDefault: row.isDefault,
    status: row.status === "paused" ? "paused" : "active",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 项目行集合 → 总览。
 *
 * `defaultProjectId` 只认**可用**（active）的默认项目：暂停中的项目仍是 `isDefault = true`（暂停不动归属），
 * 但它不再承接新建工单，把它当默认返回会让前端把工单建到一个写不进去的项目上。`state` 由此推导，
 * 三个取值分别对应前端「未开通 / 正常 / 已暂停」三个分支，不需要前端自己拼状态。
 */
function toOverview(rows: readonly TicketProjectRow[]): TicketProjectOverview {
  const activeDefault = rows.find((row) => row.isDefault && row.status === "active");
  return {
    projects: rows.map(toProjectView),
    defaultProjectId: activeDefault?.id ?? null,
    state: rows.length === 0 ? "unconfigured" : activeDefault === undefined ? "paused" : "ready",
  };
}

class TicketProjectFacade extends AuthorizedResourceFacade implements TicketProjectFacadeApi {
  private readonly projects: TicketProjectService;
  private readonly operations: TicketOperationService;
  private readonly identity: IdentityDirectory;

  constructor(options: AuthorizedResourceFacadeOptions, deps: TicketProjectFacadeDeps) {
    super(options);
    this.projects = deps.projects;
    this.operations = deps.operations;
    this.identity = deps.identity;
  }

  async list(actor: ActorContext): Promise<TicketProjectOverview> {
    const access = await this.listConstraint(actor, "read");
    return toOverview(await this.projects.listReadable(access));
  }

  /**
   * 成员候选：先按受控读取解析项目（跨组织 → 404，与其它项目路径同形），再按**项目所属组织**查成员。
   *
   * 组织取自项目行而不是 `actor.activeOrganizationId`：两者在正常情况下相同，但项目的归属才是「这份候选
   * 名单服务哪个组织」的权威答案；用 actor 的上下文会让「项目行与 actor 组织不一致」这种异常状态悄悄
   * 产出一份别组织的成员列表。
   */
  async listMembers(
    actor: ActorContext,
    projectId: string,
    query: { readonly q?: string; readonly page: number; readonly pageSize: number },
  ): Promise<TicketMemberPageView> {
    const access = await this.listConstraint(actor, "read");
    const project = await this.projects.findReadable({ access, projectId });
    if (project === undefined) throw new NotFoundError("工单项目不存在");
    const page = await this.identity.listOrganizationMembers({
      organizationId: project.organizationId,
      ...(query.q === undefined ? {} : { keyword: query.q }),
      page: query.page,
      pageSize: query.pageSize,
    });
    // 白名单搬运（`toTicketMemberView`）而不是直接展开身份目录的返回值：投影将来加字段也不会自动外泄。
    return { items: page.items.map(toTicketMemberView), total: page.total };
  }

  async provisionDefault(
    actor: ActorContext,
    input: TicketProvisionInput,
    idempotencyKey: string,
  ): Promise<TicketProvisionOutcome> {
    const scope = await this.resolveCreateScope(actor);
    const organizationId = scope.organizationId;
    // 组织资源必有归属组织（平台在缺 active organization 时已经抛错），这里只做类型收窄。
    if (organizationId === undefined) throw new Error("工单项目归属组织缺失：组织资源必须落在某个组织上");

    const outcome = await this.projects.provision({
      organizationId,
      actorId: actor.userId,
      connectionId: input.connectionId,
      mode: input.mode,
      repository: input.repository,
      idempotencyKey,
    });
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };

    // 成功终态与项目行同事务落库，账本行必然可读；读不回来说明账本被并发改写，报不变量违反而不是编造载荷。
    const operation = await this.operations.findForActor({
      organizationId,
      actorId: actor.userId,
      operationId: outcome.operationId,
    });
    if (operation === undefined) throw new Error("开通操作已成功，但账本行读不回（操作可见性与写入主体不一致）");

    return {
      kind: "ok",
      project: toProjectView(outcome.project),
      operationId: outcome.operationId,
      operation: toTicketOperationView(operation),
    };
  }

  async setDefault(
    actor: ActorContext,
    input: { projectId?: string; status?: "active" | "paused" },
  ): Promise<TicketProjectOverview> {
    const access = await this.listConstraint(actor, "read");
    const target = await this.resolveTarget(access, input.projectId);
    const organizationId = target.organizationId;
    await this.requireAction(actor, "update", target.id);

    if (input.projectId !== undefined) {
      // 切换默认到目标：目标必须可用。`paused` 与「设为默认」互斥——一个暂停项目不能承接新建工单，
      // 先切后暂停的请求因此整体失败，而不是留下一个「是默认但写不进去」的状态。
      const nextStatus = input.status ?? (target.status === "paused" ? "paused" : "active");
      if (nextStatus !== "active") throw new ConflictError("目标项目处于暂停状态：先恢复为可用，再设为默认项目");
      await this.projects.setDefault({
        organizationId,
        projectId: target.id,
        ...(input.status === undefined ? {} : { status: input.status }),
      });
    } else if (input.status !== undefined) {
      // 只改状态：作用在默认项目上（默认项目即组织工单的开关），不改动 `is_default` 归属。
      const hit = await this.projects.setStatus({ organizationId, projectId: target.id, status: input.status });
      if (!hit) throw new NotFoundError("工单项目不存在");
    }
    return await this.list(actor);
  }

  /**
   * 解析管理动作的目标项目。
   *
   * `projectId` 缺省表示「只改状态」：目标是当前组织的默认项目——优先可用的那个，否则回退到暂停中的
   * 默认项目（「恢复组织工单」正是把它重新激活）。两种情形都从受控读取的结果里挑，因此跨组织项目
   * 根本不参与解析（404）。角色判定不在这里：目标行拿到后才走 `requireAction`，两件事分开才能保证
   * 「跨组织 → 404」与「组织内成员 → 403」各自得到正确状态码。
   */
  private async resolveTarget(
    access: ResourceQueryConstraint,
    projectId: string | undefined,
  ): Promise<TicketProjectRow> {
    if (projectId !== undefined) {
      const row = await this.projects.findReadable({ access, projectId });
      if (row === undefined) throw new NotFoundError("工单项目不存在");
      return row;
    }
    const rows = await this.projects.listReadable(access);
    const target = rows.find((row) => row.isDefault && row.status === "active") ?? rows.find((row) => row.isDefault);
    if (target === undefined) throw new NotFoundError("当前组织还没有默认工单项目");
    return target;
  }

  /** 平台的授权拒绝 → 对外 403；其它错误原样上抛，避免把存储故障伪装成权限问题（收窄实现在共用文件）。 */
  private async requireAction(actor: ActorContext, action: ResourceAction, projectId: string): Promise<void> {
    await runTicketAuthorized(() => this.authorizeAction(actor, action, projectId), "当前主体无权执行该项目动作");
  }

  /** 创建期初始归属的授权拒绝 → 对外 403（成员没有开通项目的动作）。 */
  private async resolveCreateScope(actor: ActorContext) {
    return await runTicketAuthorized(() => this.resolveInitialScope(actor), "当前主体无权开通工单项目");
  }
}

/** 构造项目 Facade；只构造不读 DB、不写单例，测试可注入替身（§4.1）。 */
export function createTicketProjectFacade(deps: TicketProjectFacadeDeps): TicketProjectFacadeApi {
  return new TicketProjectFacade(
    {
      accessControl: deps.accessControl,
      resource: ticketProjectResource.definition,
      scopeStore: deps.scopeStore,
    },
    deps,
  );
}
