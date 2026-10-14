/**
 * 平台管理面（`/api/system/tickets`）的**共用上下文**：项目坐标解析、审计主体与展示名解析。
 *
 * 与 `/web` 面的 Facade 相比，这一层少了两件事、多了一件：
 *
 * - **少授权**：管理面的判据是系统路由守卫（`systemApiKeyAuth: true`，凭据即判据），宿主
 *   `systemApiAuthPlugin` 刻意不恢复用户 / 组织上下文（`apps/server/src/plugins/system-api-auth.ts`），
 *   因此这里没有 actor 可传，也没有 `listConstraint` 可用。组织内的可见性规则一条不改，仍只由 `/web` 面
 *   的受控查询表达。
 * - **少角色**：「只有创建者或组织管理员可以改」这类规则（`ticket-permission.ts`）不适用于平台管理面——
 *   它的调用方不是用户，而是平台运维者。判据只在守卫，Facade 不做第二遍角色判定（两处各判一次正是
 *   「按钮按旧规则显示、写入按新规则拒绝」这类漂移的来源，与 plugin-market 管理面同口径）。
 * - **多坐标校验**：管理面拿到的 `projectId` 来自平台列表行，可能属于**任何**组织，因此必须显式解析成
 *   项目行（不存在 → 404），后续的组织、仓库绑定、状态一律取自该行，**绝不**从请求参数推断。索引行上的
 *   归属组织也正是这样得出的（`listPlatformPage` 的 join 口径），两处同源。
 *
 * 审计主体：写路径需要一个真实主体（账本的 `actor_id`、归属行的 `author_id`、身份头里的 `author.id`）。
 * 取系统托管租户的 `userId`（`IdentityDirectory.resolveSystemTenant()` 的注释：系统托管资源的 `user_id`
 * 必须写真实用户 ID，不得伪造 actor），因此管理面不产生「匿名写入」。**刻意不缓存**：租户是部署期事实，
 * 但写路径本来就要查一次身份目录取名（`getUser`），缓存的收益在这里抵不上「进程存活期内换了系统租户却
 * 继续写旧组织」的风险（plugin-market 缓存它的前提是那条路径每次写入都要用它解析归属组织）。
 */

import type { IdentityDirectory } from "@fenix/platform-sdk";
import { NotFoundError } from "@fenix/platform-sdk";
import { OperationNotFoundError, TicketsPausedError } from "../errors";
import type { TicketProjectRow } from "../repositories/ticket-projects";
import type { TicketAttachmentService } from "../services/ticket-attachment-service";
import type { TicketCommentService } from "../services/ticket-comment-service";
import type { TicketEditService } from "../services/ticket-edit-service";
import type { TicketLabelService } from "../services/ticket-label-service";
import {
  ISSUE_CHANGE_KINDS,
  RECONCILABLE_OPERATION_STATUSES,
  type TicketOperationService,
} from "../services/ticket-operation-service";
import type { TicketProjectService } from "../services/ticket-project-service";
import type { TicketService } from "../services/ticket-service";
import type { TicketOperationRecoveryPort } from "./ticket-facade";
import { type DisplayNames, type TicketOperationView, toTicketOperationView } from "./ticket-view";

/** 平台管理面 Facade 的依赖：领域服务（无授权判断）+ 身份目录（只用于展示名与审计主体）。 */
export interface TicketPlatformFacadeDeps {
  /** 工单领域服务：跨组织查询与详情（本面不接触仓储，与其它 Facade 同口径）。 */
  readonly tickets: TicketService;
  /** 项目领域服务：按 ID 直读项目坐标（管理面没有「可见项目」的概念，见文件头）。 */
  readonly projects: TicketProjectService;
  /** 工单修改与标签挂载的领域编排（回源比对版本、写远端、刷索引、在途互斥都在它内部）。 */
  readonly edit: TicketEditService;
  /** 评论领域服务：列表、发表与修改。 */
  readonly comments: TicketCommentService;
  /** 标签领域服务：仓库标签目录（事实源在托管平台）。 */
  readonly labels: TicketLabelService;
  /** 附件领域服务：列表、上传与下载代理。 */
  readonly attachments: TicketAttachmentService;
  /** 操作账本：平台面的复核入口与在途变更查询。 */
  readonly operations: TicketOperationService;
  /** 恢复核对（§8.1）：缺省不装配，平台的复核入口即退回「只读账本」语义。 */
  readonly recovery?: TicketOperationRecoveryPort;
  /** 只用于展示名与审计主体解析，绝不参与判定。 */
  readonly identity: IdentityDirectory;
}

/** 平台写路径的审计主体：真实存在的系统托管租户用户（不是合成 actor）。 */
export interface TicketPlatformActor {
  readonly actorId: string;
  readonly actorName: string;
}

export interface TicketPlatformContext {
  /**
   * 解析项目坐标：按 ID 直读，不存在 → 404。
   *
   * 不存在与「不属于任何组织」在这里没有区分：这一面本来就允许看全部组织，`projectId` 唯一可能的问题是
   * 拼错或已被删除，两者对调用方是同一件事。参数形状（uuid）在路由 schema 已挡，不走这条路径。
   */
  requireProject(projectId: string): Promise<TicketProjectRow>;
  /** 写路径的项目解析：在 {@link requireProject} 之上加暂停闸门（与 `/web` 面同语义、同状态码）。 */
  requireWritableProject(projectId: string): Promise<TicketProjectRow>;
  /**
   * 该工单上未终结的修改操作（`issue.update` / `issue.labels`），没有则 `null`。
   *
   * 互斥组与 `/web` 面同源（`ISSUE_CHANGE_KINDS`）：两处各取一份组，就会出现「管理面看到的待确认与写路径
   * 真正拒绝的条件不一致」——界面提示与拒绝理由必须来自同一次判定。
   */
  findPendingOperationId(projectId: string, issueNumber: string): Promise<string | null>;
  /** 审计主体：系统托管租户的 `userId` 与身份目录里的当前显示名（缺名回退 `userId`）。 */
  auditActor(): Promise<TicketPlatformActor>;
  /** 一次批量解析本请求会展示到的 AOS 主体；空集合不发查询。 */
  displayNames(userIds: readonly string[]): Promise<DisplayNames>;
  /**
   * 复核一次账本行：未定状态（`dispatching` / `uncertain`）返回前回源核对一次，与 `/web` 面同一入口语义。
   *
   * 核对走 `reconcile` 的**行自身坐标**（组织 + 发起人取自账本行，不取自请求）：核对内部的可见性前置条件
   * 按同坐标读回该行。平台面已经由路由守卫完成授权，因此不需要第二条可见性路径；而它要复核的操作可能由
   * 组织成员在 `/web` 面发起（详情视图的 `pendingOperationId` 就是这种情况），用「当前调用方」当坐标反而
   * 会读不到。未装配核对实现时原样返回账本行。
   */
  reconcileOperation(operationId: string): Promise<TicketOperationView>;
}

/** 三个坐标一律取自项目行与路径参数，绝不从请求体拼接（与 `/web` 面同口径）。 */
export function ticketScopeOf(project: TicketProjectRow, issueNumber: string) {
  return {
    organizationId: project.organizationId,
    projectId: project.id,
    bindingId: project.repositoryRef,
    issueNumber,
  };
}

/** 构造管理面上下文；只构造不读 DB、不写单例，测试可注入替身。 */
export function createTicketPlatformContext(deps: TicketPlatformFacadeDeps): TicketPlatformContext {
  async function requireProject(projectId: string): Promise<TicketProjectRow> {
    const project = await deps.projects.findByIdUnscoped(projectId);
    if (project === undefined) throw new NotFoundError("工单项目不存在");
    return project;
  }

  return {
    requireProject,

    async requireWritableProject(projectId) {
      const project = await requireProject(projectId);
      // 暂停闸门与 `/web` 面同层：在领取幂等键之前判定，因此一次 503 不会烧掉调用方的幂等键。
      if (project.status === "paused") throw new TicketsPausedError();
      return project;
    },

    async findPendingOperationId(projectId, issueNumber) {
      const operationId = await deps.operations.findInFlightTarget({
        projectId,
        targetId: issueNumber,
        kinds: ISSUE_CHANGE_KINDS,
      });
      return operationId ?? null;
    },

    async auditActor() {
      const tenant = await deps.identity.resolveSystemTenant();
      return {
        actorId: tenant.userId,
        // 显示名取身份目录的当前值并写进归属快照与身份头；查不到时退化为 userId，保证字段永远非空。
        actorName: (await deps.identity.getUser(tenant.userId))?.name ?? tenant.userId,
      };
    },

    async displayNames(userIds) {
      // 空集合不发查询（整页都是外部来源时不该多一次往返），与 `/web` 面同口径。
      if (userIds.length === 0) return new Map();
      return deps.identity.listUserDisplayInfo(userIds);
    },

    async reconcileOperation(operationId) {
      const row = await deps.operations.findByIdUnscoped({ operationId });
      // 与 `/web` 面同形：不存在与「不该被看到」给同一个 404（这里没有「不该被看到」这一维，判据是守卫）。
      if (row === undefined) throw new OperationNotFoundError();
      if (deps.recovery === undefined || !RECONCILABLE_OPERATION_STATUSES.has(row.status)) {
        return toTicketOperationView(row);
      }
      // 以**账本行自身**的坐标核对（见接口注释）：组织与发起人来自那一行，不来自本次请求。
      const outcome = await deps.recovery.reconcile({
        organizationId: row.organizationId,
        actorId: row.actorId,
        operationId,
      });
      return toTicketOperationView(outcome.operation);
    },
  };
}
