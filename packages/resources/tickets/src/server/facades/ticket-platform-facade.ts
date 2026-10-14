/**
 * 工单的**平台管理面** Facade（`/api/system/tickets`）：跨组织列表、详情与工单本体的写路径。
 *
 * 为什么与 `ticket-facade.ts` 分开而不是往那个类上加方法：`TicketFacade` 的每个入口都以
 * `AuthorizedResourceFacade` 的受控查询为前置（授权判定是它的存在意义），而本面的调用方**不是一个用户**
 * ——宿主 `systemApiAuthPlugin` 刻意不恢复用户 / 组织上下文（`apps/server/src/plugins/system-api-auth.ts`），
 * 因此这里没有 actor 可传，判据就是「手里有系统 key」（`systemApiKeyAuth: true`，判据在路由守卫）。把两类
 * 凭据的入口放进同一个类，会让「哪条路径其实没有走授权」在评审时需要读完整个类才能确认；分开后，本文件的
 * 全部代码都是「已完成平台认证之后的读写编排」。
 *
 * 与 `/web` 面的**镜像关系**（冻结契约见 `docs/arch/29-tickets.md` §12）：同名操作、同一批 zod schema、
 * 同一份视图类型；差别只有三处，且都是判据不同带来的：**没有角色判定**（凭据即判据）、**没有范围收敛**
 * （跨组织正是本面的语义）、**审计主体是系统托管租户**（见 `ticket-platform-context.ts`）。业务规则一条不改：
 * 幂等键、在途互斥、版本冲突、`uncertain`（202）、暂停闸门、附件与上游的交互全部复用同一批领域服务。
 *
 * 与授权模型的关系（**不改动组织内可见性**）：`ticket_project` 仍是 `ownershipMode: "organization"` 且无
 * `visibility` 列——组织成员读项目、读工单的规则一条不变，跨组织读取只发生在这一条系统路径上。因此这里
 * 既不构造 `systemRole: "super-admin"` 的旁路 actor（决策 D8：该分支没有生产赋值点，见
 * `apps/server/src/plugins/auth.ts`），也不给 `ticket_project` 加平台受众列。
 *
 * 分层：route（协议映射）→ 本 Facade（视图组装）→ `TicketService` / `TicketEditService`（跨组织查询与
 * 写编排）→ 仓储（唯一的跨组织 SQL）。展示名与组织名解析只用于展示，失败时退化为写入期快照或 ID，绝不参与
 * 任何判定。评论 / 附件 / 标签目录 / 成员的编排在 `ticket-platform-content-facade.ts`，由本文件组装成一个
 * 门面（`/api/system/tickets` 对调用方就是一个面）。
 */

import type { TicketIndexPlatformRow } from "../repositories/ticket-index";
import type { TicketEditOutcome, TicketUpdateIssueInput } from "../services/ticket-edit-service";
import type { TicketPlatformListInput } from "../services/ticket-service";
import type { TicketEditOutcomeView, TicketUpdateInput } from "./ticket-facade";
import { createTicketPlatformContent, type TicketPlatformContentApi } from "./ticket-platform-content-facade";
import { createTicketPlatformContext, type TicketPlatformFacadeDeps, ticketScopeOf } from "./ticket-platform-context";
import {
  collectFactsActorIds,
  collectIndexActorIds,
  type TicketDetailView,
  type TicketOperationView,
  type TicketSummaryView,
  toTicketDetailView,
  toTicketSummaryView,
} from "./ticket-view";

export type {
  TicketActorView,
  TicketDetailView,
  TicketListPage,
  TicketOperationView,
  TicketSummaryView,
} from "./ticket-view";

/**
 * 管理面列表行：`/web` 列表行的字段（同源同义，仍是 `ticket_index` 的投影）再加**归属坐标**。
 *
 * 跨组织视图里没有项目与组织坐标，两行 `#7` 就无法区分，管理员也就无法判断该找谁。坐标取自
 * `ticket_projects` 的仓库快照（不是事实源回读）：列表不回源上游，坐标可能落后于远端改名，这一点与
 * `/web` 列表同源同级别。
 */
export interface TicketPlatformSummaryView extends TicketSummaryView {
  readonly organizationId: string;
  /** 组织展示名；身份目录查不到时回退为组织 ID（展示退化，不影响请求成功与否）。 */
  readonly organizationName: string;
  readonly projectId: string;
  /** 仓库名（`ticket_projects.name`）。 */
  readonly projectName: string;
  /** 仓库 owner（托管平台命名空间），与 `projectName` 一起构成仓库坐标。 */
  readonly projectOwner: string;
}

export interface TicketPlatformListPage {
  readonly items: readonly TicketPlatformSummaryView[];
  /** 同一筛选条件下的命中总数（跨页）。 */
  readonly total: number;
}

export interface TicketPlatformFacadeApi extends TicketPlatformContentApi {
  /** 跨组织分页列出工单索引（只读）。不接收 actor：判据是系统路由守卫。 */
  list(query: TicketPlatformListInput): Promise<TicketPlatformListPage>;
  /** 工单详情：回源托管平台取正文并核验作者（上游不可用报 503，**绝不**返回空正文）。 */
  getTicket(projectId: string, issueNumber: string): Promise<TicketDetailView>;
  /** 修改标题 / 描述 / 负责人 / 状态：字段缺席 = 不改，`assigneeId: null` = 取消指派。 */
  updateTicket(
    projectId: string,
    issueNumber: string,
    input: TicketUpdateInput,
    idempotencyKey: string,
  ): Promise<TicketEditOutcomeView>;
  /** 标签挂载（全量集合语义，空数组 = 清空）；版本与在途互斥口径与 `/web` 面一致。 */
  setTicketLabels(
    projectId: string,
    issueNumber: string,
    input: { readonly labelIds: readonly string[]; readonly expectedVersion: string },
    idempotencyKey: string,
  ): Promise<TicketEditOutcomeView>;
  /** 复核一次操作账本（202 之后的入口）：未定状态返回前回源核对一次，语义见上下文的 `reconcileOperation`。 */
  getOperation(operationId: string): Promise<TicketOperationView>;
}

/** 构造管理面 Facade；只构造不读 DB、不写单例，测试可注入替身。 */
export function createTicketPlatformFacade(deps: TicketPlatformFacadeDeps): TicketPlatformFacadeApi {
  const context = createTicketPlatformContext(deps);
  const content = createTicketPlatformContent(deps, context);

  /** 跨组织列表：索引行 + 两次展示解析（作者名与组织名并行，互不依赖）。 */
  async function list(query: TicketPlatformListInput): Promise<TicketPlatformListPage> {
    const page = await deps.tickets.listPlatformPage(query);
    const [displayNames, organizationNames] = await Promise.all([
      context.displayNames(collectIndexActorIds(page.items.map((row) => row.issue))),
      resolveOrganizationNames(page.items),
    ]);
    return {
      items: page.items.map((row) => ({
        ...toTicketSummaryView(row.issue, displayNames),
        organizationId: row.organizationId,
        organizationName: organizationNames.get(row.organizationId) ?? row.organizationId,
        projectId: row.projectId,
        projectName: row.projectName,
        projectOwner: row.projectOwner,
      })),
      total: page.total,
    };
  }

  /** 一次批量解析本页涉及的组织名；去重后查询，缺名时由调用方回退成 ID。 */
  async function resolveOrganizationNames(
    rows: readonly TicketIndexPlatformRow[],
  ): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(rows.map((row) => row.organizationId))];
    if (unique.length === 0) return new Map();
    return deps.identity.listOrganizationNames(unique);
  }

  /** 修改类写结果 → 视图：成功时回读一次远端拼详情（`/web` 面同口径），未定只给出 operationId。 */
  async function toEditOutcomeView(outcome: TicketEditOutcome): Promise<TicketEditOutcomeView> {
    if (outcome.kind === "uncertain") return { kind: "uncertain", operationId: outcome.operationId };
    return {
      kind: "updated",
      // 刚写入成功的工单不可能有在途变更：账本行在返回前已是成功终态。
      ticket: toTicketDetailView(outcome.facts, await context.displayNames(collectFactsActorIds(outcome.facts)), null),
      operationId: outcome.operationId,
    };
  }

  return {
    ...content,
    list,

    async getTicket(projectId, issueNumber) {
      const project = await context.requireProject(projectId);
      const facts = await deps.tickets.getIssue({
        organizationId: project.organizationId,
        projectId: project.id,
        bindingId: project.repositoryRef,
        issueNumber,
      });
      // 两次无关的读取并行：展示名解析（身份目录）与在途变更查询（账本）互不依赖。
      const [displayNames, pendingOperationId] = await Promise.all([
        context.displayNames(collectFactsActorIds(facts)),
        context.findPendingOperationId(project.id, issueNumber),
      ]);
      return toTicketDetailView(facts, displayNames, pendingOperationId);
    },

    async updateTicket(projectId, issueNumber, input, idempotencyKey) {
      const project = await context.requireWritableProject(projectId);
      const actor = await context.auditActor();
      const outcome = await deps.edit.updateIssue({
        ...ticketScopeOf(project, issueNumber),
        actorId: actor.actorId,
        actorName: actor.actorName,
        ...input,
        idempotencyKey,
      } satisfies TicketUpdateIssueInput);
      return await toEditOutcomeView(outcome);
    },

    async setTicketLabels(projectId, issueNumber, input, idempotencyKey) {
      const project = await context.requireWritableProject(projectId);
      const actor = await context.auditActor();
      const outcome = await deps.edit.setLabels({
        ...ticketScopeOf(project, issueNumber),
        actorId: actor.actorId,
        labelIds: input.labelIds,
        expectedVersion: input.expectedVersion,
        idempotencyKey,
      });
      return await toEditOutcomeView(outcome);
    },

    async getOperation(operationId) {
      return await context.reconcileOperation(operationId);
    },
  };
}
