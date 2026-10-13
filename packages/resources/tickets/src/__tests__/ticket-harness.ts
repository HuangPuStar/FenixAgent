/**
 * 工单 T03 后端用例的共享装配（backend contract §12 的「记录型仓储替身 + 真实领域服务」口径）。
 *
 * 为什么集中一处：五条被测路径（工单修改、评论、标签、恢复核对、成员）需要同一套接缝——可编程 Git 替身、
 * 记录型仓储、身份目录 stub 与真实 Facade 装配。逐文件复制会让「claim 的唯一键裁决」「在途互斥谓词」
 * 「索引刷新的继承口径」这类必须逐字一致的替身语义各自漂移，修正一处要改五份。
 *
 * 替身只复刻**被断言到的**语义：记录调用、按用例给响应、复刻唯一键与在途谓词。不复刻事务回滚
 * （单进程用例没有真并发，见 operation store 的注释）；不复刻 SQL，列与索引谓词归 `repositories.test.ts`。
 *
 * 与既有文件的边界：`facades.test.ts` / `tickets-create.test.ts` 是 T02 的用例，自持装配且已全绿，本文件
 * 不为它们做重构，只服务 T03 新增用例。
 */

import { randomUUID } from "node:crypto";
import type {
  CreateCommentInput,
  CreateIssueInput,
  CreateLabelInput,
  EditCommentInput,
  EditIssueInput,
  EditLabelInput,
  GitAttachment,
  GitAttachmentDownload,
  GitComment,
  GitIssue,
  GitIssueListQuery,
  GitLabel,
  GitListQuery,
  GitPage,
  GitRepository,
  GitScopedClient,
  GitService,
  UploadAttachmentInput,
} from "@fenix/git/server";
import {
  type AccessControlModule,
  type ActorContext,
  type MemberRole,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  ResourceAccessDeniedError,
  type ResourceQueryConstraint,
  type ResourceScopeStore,
  type UserDisplayInfo,
} from "@fenix/platform-sdk";
import { getDatabase, getIdentityDirectory } from "@fenix/platform-sdk/server";
import { stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { Elysia, ValidationError as ElysiaValidationError } from "elysia";
import { ticketProjectResource } from "../server/access/ticket-project-resource";
import {
  createTicketAttachmentFacade,
  type TicketAttachmentFacadeApi,
} from "../server/facades/ticket-attachment-facade";
import { createTicketCommentFacade, type TicketCommentFacadeApi } from "../server/facades/ticket-comment-facade";
import { createTicketFacade, type TicketFacadeApi } from "../server/facades/ticket-facade";
import { createTicketLabelFacade, type TicketLabelFacadeApi } from "../server/facades/ticket-label-facade";
import { createTicketProjectFacade, type TicketProjectFacadeApi } from "../server/facades/ticket-project-facade";
import type { TicketIndexRepository, TicketIndexRow } from "../server/repositories/ticket-index";
import type { TicketMessageRepository, TicketMessageRow } from "../server/repositories/ticket-messages";
import type { TicketOperationRepository, TicketOperationRow } from "../server/repositories/ticket-operations";
import type {
  ScopedTicketProjectRow,
  TicketProjectRepository,
  TicketProjectRow,
} from "../server/repositories/ticket-projects";
import { createWebTicketRoutes } from "../server/routes/web/index";
import { installTicketsServerModule } from "../server/runtime";
import { buildTicketBody, hashBody } from "../server/services/identity-header";
import {
  createTicketAttachmentService,
  type TicketAttachmentService,
} from "../server/services/ticket-attachment-service";
import { createTicketCommentService, type TicketCommentService } from "../server/services/ticket-comment-service";
import { createTicketEditService, type TicketEditService } from "../server/services/ticket-edit-service";
import { createTicketLabelService, type TicketLabelService } from "../server/services/ticket-label-service";
import { createTicketOperationService, type TicketOperationService } from "../server/services/ticket-operation-service";
import { createTicketProjectService, type TicketProjectService } from "../server/services/ticket-project-service";
import { createTicketRecoveryService, type TicketRecoveryService } from "../server/services/ticket-recovery-service";
import { createTicketService, type TicketService } from "../server/services/ticket-service";

export const ORG_A = "org_alpha";
export const ORG_B = "org_beta";
export const PROJECT_A = "11111111-1111-4111-8111-111111111111";
export const PROJECT_B = "33333333-3333-4333-8333-333333333333";
export const BINDING_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const BINDING_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const IDEMPOTENCY_KEY = "idem-key-0001";
export const FIXTURE_NOW = new Date("2026-10-12T08:00:00.000Z");

/** 一个事务持有的行锁集合；提交或回滚时整体释放（见 {@link releaseRowLocks}）。 */
interface RowLockScope {
  readonly held: Set<string>;
}

/** 事务替身句柄：`runInTransaction` 要 `execute`（语句超时设置），`rowLocks` 供 `findByIdForUpdate` 排队。 */
export interface TicketTransactionHandle {
  readonly execute: () => Promise<void>;
  readonly rowLocks: RowLockScope;
}

/**
 * 行锁表：`operationId → 持有它的事务`，配一张等待者表。
 *
 * 为什么替身要有锁：真实实现靠 `SELECT ... FOR UPDATE` 让并发的核对串行化（第二个读到终态就直接返回），
 * 单进程替身若只是「读一行返回」，两个 `Promise.all` 的核对会同时通过状态复查，第二个补归属行时撞
 * `message_id` 唯一索引——于是用例只能测出替身的缺陷，测不出实现。锁在这里复刻的正是那段排队语义。
 */
const rowLockHolders = new Map<string, RowLockScope>();
const rowLockWaiters = new Map<string, Set<() => void>>();

/** 当前事务的行锁集合；事务外（如 T02 的直读路径）为 `undefined`，此时不加锁。 */
function currentRowLockScope(): RowLockScope | undefined {
  return getDatabase<{ readonly rowLocks?: RowLockScope }>()?.rowLocks;
}

/** 取行锁：同行的另一个事务持有时排队，被唤醒后重新竞争（与 `FOR UPDATE` 的阻塞语义一致）。 */
async function acquireRowLock(scope: RowLockScope | undefined, operationId: string): Promise<void> {
  if (scope === undefined) return;
  for (;;) {
    const holder = rowLockHolders.get(operationId);
    if (holder === undefined) {
      rowLockHolders.set(operationId, scope);
      scope.held.add(operationId);
      return;
    }
    if (holder === scope) return;
    await new Promise<void>((resolve) => {
      const waiters = rowLockWaiters.get(operationId) ?? new Set<() => void>();
      waiters.add(resolve);
      rowLockWaiters.set(operationId, waiters);
    });
  }
}

/** 事务结束（含抛错）时释放本事务持有的全部行锁，并唤醒等待者。 */
function releaseRowLocks(scope: RowLockScope): void {
  for (const operationId of scope.held) {
    if (rowLockHolders.get(operationId) === scope) rowLockHolders.delete(operationId);
    const waiters = rowLockWaiters.get(operationId);
    if (waiters === undefined) continue;
    rowLockWaiters.delete(operationId);
    for (const wake of waiters) wake();
  }
  scope.held.clear();
}

/** 事务替身：`runInTransaction` 需要 `transaction(callback)` 与事务句柄的 `execute`（语句超时设置）。 */
export const DATABASE_STUB = {
  execute: async () => undefined,
  async transaction<TResult>(run: (handle: TicketTransactionHandle) => Promise<TResult>): Promise<TResult> {
    const handle: TicketTransactionHandle = { execute: async () => undefined, rowLocks: { held: new Set() } };
    try {
      return await run(handle);
    } finally {
      releaseRowLocks(handle.rowLocks);
    }
  },
};

/** 构造可信主体；`organizationId` 缺省表示凭据没有组织上下文。 */
export function testActor(
  userId: string,
  organizationId: string | undefined,
  role: MemberRole = "member",
): ActorContext {
  return {
    kind: "user",
    userId,
    ...(organizationId === undefined ? {} : { activeOrganizationId: organizationId }),
    memberships: organizationId === undefined ? [] : [{ organizationId, role }],
  };
}

/** 当前组织里的成员角色；授权替身的判定依据（actor 是成员关系的全量投影）。 */
export function roleInActiveOrg(actor: ActorContext): MemberRole | undefined {
  return actor.memberships.find((membership) => membership.organizationId === actor.activeOrganizationId)?.role;
}

/** 组织成员投影（`{userId, name}`）：`resolveMembershipId` 与 `listOrganizationMembers` 同源声明。 */
export interface StubMember {
  readonly userId: string;
  readonly name: string;
}

/**
 * 声明身份目录投影。
 *
 * `membersOf` 同时喂 `resolveMembershipId`（负责人核验）与 `listOrganizationMembers`（成员候选）：
 * 两者在生产里读同一张成员表，分成两份声明会让「指派核验通过但成员列表里没有他」这种不可能状态出现在用例里。
 * `listOrganizationMembers` 的默认实现刻意保持空投影以外的最小行为——分页与关键字由它自己按声明表过滤。
 */
export function stubDirectory(input: {
  readonly users?: readonly { readonly id: string; readonly name: string }[];
  readonly membersOf?: Readonly<Record<string, readonly StubMember[]>>;
}): void {
  const byId = new Map<string, UserDisplayInfo>(
    (input.users ?? []).map((user) => [user.id, { id: user.id, name: user.name, email: `${user.id}@example.test` }]),
  );
  const membersOf = input.membersOf ?? {};
  stubIdentityDirectory({
    getUser: async (userId) => byId.get(userId),
    listUserDisplayInfo: async (userIds) => {
      const found: Array<[string, UserDisplayInfo]> = [];
      for (const userId of userIds) {
        const info = byId.get(userId);
        if (info !== undefined) found.push([userId, info]);
      }
      return new Map(found);
    },
    resolveMembershipId: async ({ organizationId, userId }) => {
      const member = (membersOf[organizationId] ?? []).find((candidate) => candidate.userId === userId);
      return member === undefined ? undefined : `membership_${organizationId}_${member.userId}`;
    },
    listOrganizationMembers: async ({ organizationId, keyword, page, pageSize }) => {
      const all = membersOf[organizationId] ?? [];
      const hits = keyword === undefined ? all : all.filter((member) => member.name.includes(keyword));
      const start = (page - 1) * pageSize;
      return { items: hits.slice(start, start + pageSize).map((member) => ({ ...member })), total: hits.length };
    },
  });
}

/**
 * 授权实现替身：条件只匹配 actor 的 active organization，组织内成员只获得 `read`。
 *
 * 与 `facades.test.ts` 同形：角色 → 动作的推导由 `@fenix/access-control` 的用例覆盖，这里固定的是 Facade
 * 依赖的契约形状（条件内嵌组织归属；`resolveInitialScope` / `authorize(update)` 对成员拒绝）。
 */
export function createFakeAccessControl(constraints: ResourceQueryConstraint[]): AccessControlModule {
  const denied = (): never => {
    throw new ResourceAccessDeniedError("当前主体无权执行资源动作");
  };
  return {
    id: "test-access-control",
    resolveInitialScope: async ({ actor }) => {
      const role = roleInActiveOrg(actor);
      if (actor.activeOrganizationId === undefined || role === undefined || role === "member") denied();
      return { organizationId: actor.activeOrganizationId, visibility: "private" };
    },
    initializeResourceAccess: async () => undefined,
    authorize: async ({ actor, action }) => {
      if (action === "update" && roleInActiveOrg(actor) !== "owner" && roleInActiveOrg(actor) !== "admin") denied();
    },
    createListConstraint: async ({ actor, action, resource }) => {
      if (actor.activeOrganizationId === undefined) denied();
      const constraint: ResourceQueryConstraint = {
        resourceType: resource.type,
        action,
        provider: "test-access-control",
        [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: {
          organizationId: actor.activeOrganizationId,
          role: roleInActiveOrg(actor),
        },
      };
      constraints.push(constraint);
      return constraint;
    },
    resolveAccess: async () => ({ actions: ["read", "create", "update"] }),
    resolveAccessMany: async ({ resourceIds }) =>
      new Map(resourceIds.map((resourceId) => [resourceId, { actions: ["read", "create", "update"] as const }])),
  };
}

/** 读出条件的组织归属（真实实现按同一符号写入；资源包自身代码不得解析它）。 */
export function constraintOrg(access: ResourceQueryConstraint): string | undefined {
  const payload = access[RESOURCE_QUERY_CONSTRAINT_PAYLOAD] as { readonly organizationId?: string } | undefined;
  return payload?.organizationId;
}

/** Facade 不使用的 scope store：任何调用都视为行为回归。 */
export function unusedScopeStore(): ResourceScopeStore {
  const unused = async (): Promise<never> => {
    throw new Error("Facade 的授权编排不应触碰 scope store");
  };
  return { initialize: unused, getMany: unused, update: unused, remove: unused };
}

export function projectRow(seed: Partial<TicketProjectRow> & { readonly id: string; readonly organizationId: string }) {
  return {
    id: seed.id,
    organizationId: seed.organizationId,
    repositoryRef: seed.repositoryRef ?? randomUUID(),
    connectionId: seed.connectionId ?? "primary",
    providerRepositoryId: seed.providerRepositoryId ?? "repo-alpha",
    owner: seed.owner ?? "aos-bot",
    name: seed.name ?? "aos-tickets-alpha",
    isDefault: seed.isDefault ?? false,
    status: seed.status ?? "active",
    createdBy: seed.createdBy ?? "user_admin",
    createdAt: seed.createdAt ?? FIXTURE_NOW,
    updatedAt: seed.updatedAt ?? FIXTURE_NOW,
  };
}

export interface ProjectStore {
  readonly rows: TicketProjectRow[];
  /** 受控读取收到的条件；用于断言「条件原样下推」。 */
  readonly accesses: ResourceQueryConstraint[];
  readonly repository: TicketProjectRepository;
  seed(input: Partial<TicketProjectRow> & { readonly id: string; readonly organizationId: string }): TicketProjectRow;
}

/** 记录型项目仓储：受控读取按条件的组织归属过滤，无授权读取按主键直接命中。 */
export function createProjectStore(): ProjectStore {
  const rows: TicketProjectRow[] = [];
  const accesses: ResourceQueryConstraint[] = [];
  const scoped = (row: TicketProjectRow): ScopedTicketProjectRow => ({
    ...row,
    scope: { organizationId: row.organizationId, visibility: "private" },
  });
  const visibleIn = (access: ResourceQueryConstraint) => {
    accesses.push(access);
    return rows.filter((row) => row.organizationId === constraintOrg(access));
  };
  return {
    rows,
    accesses,
    seed(input) {
      const row = projectRow(input);
      rows.push(row);
      return row;
    },
    repository: {
      async listReadable({ access, limit, offset }) {
        const visible = visibleIn(access).slice(offset ?? 0);
        const items = limit === undefined ? visible : visible.slice(0, limit);
        return { items: items.map(scoped), total: visible.length };
      },
      async findReadableById({ access, projectId }) {
        const row = visibleIn(access).find((candidate) => candidate.id === projectId);
        return row === undefined ? undefined : scoped(row);
      },
      async findByIdUnscoped(projectId) {
        return rows.find((row) => row.id === projectId);
      },
      async findByBindingId(bindingId) {
        return rows.find((row) => row.repositoryRef === bindingId);
      },
      async listByOrganizationUnscoped(organizationId) {
        return rows.filter((row) => row.organizationId === organizationId);
      },
      async upsertByBinding(input) {
        const existing = rows.find((row) => row.repositoryRef === input.bindingId);
        if (existing !== undefined) {
          existing.connectionId = input.connectionId;
          existing.providerRepositoryId = input.providerRepositoryId;
          existing.owner = input.owner;
          existing.name = input.name;
          return existing;
        }
        const created = projectRow({
          id: randomUUID(),
          organizationId: input.organizationId,
          repositoryRef: input.bindingId,
          connectionId: input.connectionId,
          providerRepositoryId: input.providerRepositoryId,
          owner: input.owner,
          name: input.name,
          createdBy: input.createdBy,
          isDefault: true,
        });
        rows.push(created);
        return created;
      },
      async setDefault({ organizationId, projectId }) {
        for (const row of rows) {
          if (row.organizationId === organizationId && row.isDefault && row.id !== projectId) row.isDefault = false;
        }
        const target = rows.find((row) => row.id === projectId && row.organizationId === organizationId);
        if (target !== undefined) target.isDefault = true;
      },
      async setStatus({ organizationId, projectId, status }) {
        const target = rows.find((row) => row.id === projectId && row.organizationId === organizationId);
        if (target === undefined) return false;
        target.status = status;
        return true;
      },
    },
  };
}

export interface OperationStore {
  readonly rows: TicketOperationRow[];
  readonly repository: TicketOperationRepository;
  /** 直接落一行账本（供恢复核对用例构造 `dispatching` / `uncertain` / 超窗口的既有行）。 */
  seed(input: Partial<TicketOperationRow> & { readonly status: TicketOperationRow["status"] }): TicketOperationRow;
}

/**
 * 记录型操作账本：复刻 `claim` 的唯一键裁决、`markDispatching` 的条件更新与在途互斥谓词（SQL 侧见
 * `repositories.test.ts`）。
 *
 * 替身没有事务回滚语义：真实实现在 `begin` 里抛错时本次声明行会随事务消失，这里做不到——涉及互斥拒绝的
 * 用例因此只断言「既存行未被改写」与「零出站」，不断言行数。
 */
export function createOperationStore(): OperationStore {
  const rows: TicketOperationRow[] = [];
  const find = (operationId: string) => rows.find((row) => row.id === operationId);
  const require = (operationId: string): TicketOperationRow => {
    const row = find(operationId);
    if (row === undefined) throw new Error("替身账本里没有这条操作");
    return row;
  };
  /** 在途谓词（`hasInFlightTarget` 与 `findInFlightTargetId` 共用一份，避免替身内部两份判定分叉）。 */
  const findInFlightOperationId = (input: {
    readonly projectId: string;
    readonly targetId: string;
    readonly kinds: readonly string[];
    readonly excludeOperationId?: string;
  }): string | undefined =>
    rows
      .filter(
        (row) =>
          row.projectId === input.projectId &&
          row.targetId === input.targetId &&
          input.kinds.includes(row.kind) &&
          row.id !== input.excludeOperationId &&
          // 终态（succeeded / failed）不算在途；`needs_review` 算，与仓储实现的谓词一致。
          row.status !== "succeeded" &&
          row.status !== "failed",
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]?.id;
  return {
    rows,
    seed(input) {
      const row: TicketOperationRow = {
        id: input.id ?? randomUUID(),
        organizationId: input.organizationId ?? ORG_A,
        projectId: input.projectId === undefined ? PROJECT_A : input.projectId,
        actorId: input.actorId ?? "user_creator",
        kind: input.kind ?? "issue.update",
        targetId: input.targetId === undefined ? "1" : input.targetId,
        idempotencyKey: input.idempotencyKey ?? IDEMPOTENCY_KEY,
        requestHash: input.requestHash ?? "hash-existing",
        messageId: input.messageId === undefined ? "msg_existing" : input.messageId,
        expectedVersion: input.expectedVersion === undefined ? null : input.expectedVersion,
        intent: input.intent ?? {},
        step: input.step === undefined ? "dispatching" : input.step,
        status: input.status,
        result: input.result === undefined ? null : input.result,
        createdAt: input.createdAt ?? FIXTURE_NOW,
        updatedAt: input.updatedAt ?? FIXTURE_NOW,
      };
      rows.push(row);
      return row;
    },
    repository: {
      async claim(input) {
        const existing = rows.find(
          (row) =>
            row.organizationId === input.organizationId &&
            row.actorId === input.actorId &&
            row.idempotencyKey === input.idempotencyKey,
        );
        if (existing !== undefined) return { outcome: "existing", row: existing };
        const created: TicketOperationRow = {
          id: randomUUID(),
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorId: input.actorId,
          kind: input.kind,
          targetId: input.targetId ?? null,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          messageId: input.messageId,
          expectedVersion: input.expectedVersion,
          intent: input.intent,
          step: null,
          status: "pending",
          result: null,
          createdAt: FIXTURE_NOW,
          updatedAt: FIXTURE_NOW,
        };
        rows.push(created);
        return { outcome: "created", row: created };
      },
      async markDispatching({ operationId, step }) {
        const row = find(operationId);
        if (row === undefined || row.status !== "pending") return false;
        row.status = "dispatching";
        row.step = step;
        return true;
      },
      async markSucceeded({ operationId, step, targetId, result, intentSummary }) {
        const row = require(operationId);
        row.status = "succeeded";
        row.step = step;
        row.targetId = targetId;
        row.result = result;
        row.intent = intentSummary;
      },
      async markFailed({ operationId, step, result }) {
        const row = require(operationId);
        row.status = "failed";
        row.step = step;
        row.result = result;
      },
      async markUncertain({ operationId, step, status = "uncertain" }) {
        const row = require(operationId);
        row.status = status;
        row.step = step;
      },
      async findForActor({ organizationId, actorId, operationId }) {
        return rows.find(
          (row) => row.id === operationId && row.organizationId === organizationId && row.actorId === actorId,
        );
      },
      async findByMessageId(messageId) {
        return rows.find((row) => row.messageId === messageId);
      },
      // 按主键加锁读（`SELECT ... FOR UPDATE` 的替身）：同行的并发事务在此排队，等前者提交后再读。
      async findByIdForUpdate({ operationId }) {
        await acquireRowLock(currentRowLockScope(), operationId);
        return find(operationId);
      },
      async hasInFlightTarget(input) {
        return findInFlightOperationId(input) !== undefined;
      },
      // 与 hasInFlightTarget 同谓词（共用同一个局部函数），只多取回命中的操作 ID。
      async findInFlightTargetId({ projectId, targetId, kinds, excludeOperationId }) {
        return findInFlightOperationId({ projectId, targetId, kinds, excludeOperationId });
      },
      // 复刻单语句 jsonb 追加的结果形状（`result.steps[]` 只是审计轨迹：恢复核对的事实源是
      // `ticket_operations.step` 列与 `expected_version` / `intent`，全仓没有 `result.steps` 的读取点）。
      async checkpoint({ operationId, step, expected }) {
        const row = require(operationId);
        const result = typeof row.result === "object" && row.result !== null ? { ...row.result } : {};
        const steps = Array.isArray(result.steps) ? result.steps : [];
        row.result = { ...result, steps: [...steps, { step, at: FIXTURE_NOW, expected }] };
      },
      async findUnsettled({ updatedBefore, limit }) {
        return rows
          .filter(
            (row) => (row.status === "dispatching" || row.status === "uncertain") && row.updatedAt <= updatedBefore,
          )
          .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
          .slice(0, limit);
      },
    },
  };
}

export interface MessageStore {
  readonly rows: TicketMessageRow[];
  /** `findManyByMessageIds` 的调用次数；断言「一次列表只发一次批量归属查询」。 */
  readonly batchQueries: number;
  readonly repository: TicketMessageRepository;
}

/** 记录型归属仓储：三个唯一索引（对象、message_id、项目内对象）的冲突一律抛出，不做静默改写。 */
export function createMessageStore(): MessageStore {
  const rows: TicketMessageRow[] = [];
  let batchQueries = 0;
  return {
    rows,
    get batchQueries() {
      return batchQueries;
    },
    repository: {
      async insert(input) {
        if (rows.some((row) => row.messageId === input.messageId)) {
          throw new Error("ticket_messages 唯一索引冲突：message_id 已存在");
        }
        const objectRow = rows.find((row) => row.projectId === input.projectId && row.objectKind === input.objectKind);
        if (objectRow !== undefined && objectRow.providerObjectId === input.providerObjectId) {
          throw new Error("ticket_messages 唯一索引冲突：对象归属已存在");
        }
        const row: TicketMessageRow = {
          id: randomUUID(),
          projectId: input.projectId,
          objectKind: input.objectKind,
          providerObjectId: input.providerObjectId,
          messageId: input.messageId,
          authorId: input.authorId,
          authorNameSnapshot: input.authorNameSnapshot,
          bodyHash: input.bodyHash,
          revision: input.revision ?? 1,
          lastEditorId: input.lastEditorId ?? null,
          createdAt: FIXTURE_NOW,
          updatedAt: FIXTURE_NOW,
        };
        rows.push(row);
        return row;
      },
      async findObjectMessage({ projectId, objectKind, providerObjectId }) {
        return rows.find(
          (row) =>
            row.projectId === projectId && row.objectKind === objectKind && row.providerObjectId === providerObjectId,
        );
      },
      async findByMessageId({ messageId }) {
        return rows.find((row) => row.messageId === messageId);
      },
      async findManyByMessageIds({ projectId, messageIds }) {
        batchQueries += 1;
        return rows.filter((row) => row.projectId === projectId && messageIds.includes(row.messageId));
      },
      // 正文改写只换哈希与版本：作者与作者快照保持不变（编辑不转移作者）。
      async updateRevision({ id, bodyHash, lastEditorId }) {
        const row = rows.find((candidate) => candidate.id === id);
        if (row === undefined) throw new Error("ticket_messages 归属行不存在，无法刷新正文版本");
        row.bodyHash = bodyHash;
        row.revision += 1;
        row.lastEditorId = lastEditorId;
        return row;
      },
    },
  };
}

export interface IndexStore {
  readonly rows: TicketIndexRow[];
  /** 列表查询入参（原样记录，含筛选条件）；用于断言条件与分页下推。 */
  readonly queries: Array<{
    readonly projectId: string;
    readonly limit: number;
    readonly cursor?: string;
    readonly q?: string;
    readonly state?: "open" | "closed" | "all";
    readonly assigneeId?: string;
    readonly labelId?: string;
  }>;
  /** 故障注入：非 null 时 `upsertIssue` 直接抛出（模拟「远端已写、本地终态写失败」的 202 分支）。 */
  failUpsert: Error | null;
  readonly repository: TicketIndexRepository;
  seed(input: Partial<TicketIndexRow> & { readonly projectId: string; readonly issueNumber: string }): TicketIndexRow;
}

/** 记录型索引仓储：排序与游标语义照生产（工单号数值降序、游标为排他上界）。 */
export function createIndexStore(): IndexStore {
  const rows: TicketIndexRow[] = [];
  const queries: IndexStore["queries"] = [];
  const seed = (input: Partial<TicketIndexRow> & { readonly projectId: string; readonly issueNumber: string }) => {
    const row: TicketIndexRow = {
      id: randomUUID(),
      projectId: input.projectId,
      issueNumber: input.issueNumber,
      title: input.title ?? `工单 ${input.issueNumber}`,
      state: input.state ?? "open",
      authorId: input.authorId ?? null,
      authorName: input.authorName ?? null,
      assigneeId: input.assigneeId ?? null,
      labelIds: input.labelIds ?? [],
      contentVersion: input.contentVersion ?? "version-1",
      providerUpdatedAt: input.providerUpdatedAt ?? null,
      syncedAt: input.syncedAt ?? FIXTURE_NOW,
      syncStatus: input.syncStatus ?? "ready",
    };
    rows.push(row);
    return row;
  };
  const store: IndexStore = {
    rows,
    queries,
    failUpsert: null,
    seed,
    repository: {
      async upsertIssue(input) {
        if (store.failUpsert !== null) throw store.failUpsert;
        const existing = rows.find((row) => row.projectId === input.projectId && row.issueNumber === input.issueNumber);
        if (existing !== undefined) {
          // 冲突时刷新的列与生产实现逐列对齐（`ticket-index.ts` 的 `refreshed`）：漏掉 `assigneeId` 会让
          // 「指派后索引里仍是旧负责人」这种假失败出现在用例里，而生产根本不会发生。
          existing.title = input.title;
          existing.state = input.state;
          existing.authorId = input.authorId;
          existing.authorName = input.authorName;
          existing.assigneeId = input.assigneeId;
          existing.labelIds = [...input.labelIds];
          existing.contentVersion = input.contentVersion;
          existing.providerUpdatedAt = input.providerUpdatedAt;
          existing.syncStatus = input.syncStatus ?? "ready";
          existing.syncedAt = FIXTURE_NOW;
          return existing;
        }
        return seed({
          projectId: input.projectId,
          issueNumber: input.issueNumber,
          title: input.title,
          state: input.state,
          authorId: input.authorId,
          authorName: input.authorName,
          assigneeId: input.assigneeId,
          labelIds: [...input.labelIds],
          contentVersion: input.contentVersion,
          providerUpdatedAt: input.providerUpdatedAt,
          syncStatus: input.syncStatus,
        });
      },
      async listPage(input) {
        queries.push({
          projectId: input.projectId,
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.q === undefined ? {} : { q: input.q }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
          ...(input.labelId === undefined ? {} : { labelId: input.labelId }),
        });
        return (
          rows
            .filter((row) => row.projectId === input.projectId)
            .filter((row) => input.cursor === undefined || BigInt(row.issueNumber) < BigInt(input.cursor))
            // 筛选口径与生产 SQL 对齐（`state = 'all'` 与缺省都表示不过滤），否则「指派后筛选可见」会在替身里假通过。
            .filter((row) => input.state === undefined || input.state === "all" || row.state === input.state)
            .filter((row) => input.assigneeId === undefined || row.assigneeId === input.assigneeId)
            .filter((row) => input.labelId === undefined || row.labelIds.includes(input.labelId))
            .filter((row) => input.q === undefined || row.title.includes(input.q))
            .sort((left, right) => (BigInt(right.issueNumber) < BigInt(left.issueNumber) ? -1 : 1))
            .slice(0, input.limit)
        );
      },
      async findByIssueNumber({ projectId, issueNumber }) {
        return rows.find((row) => row.projectId === projectId && row.issueNumber === issueNumber);
      },
      async countByProject(projectId) {
        return rows.filter((row) => row.projectId === projectId).length;
      },
    },
  };
  return store;
}

export function gitRepository(overrides: Partial<GitRepository["ref"]> = {}): GitRepository {
  return {
    ref: {
      connectionId: "primary",
      providerRepositoryId: "repo-alpha",
      owner: "aos-bot",
      name: "aos-tickets-alpha",
      ...overrides,
    },
    isPrivate: true,
    issuesEnabled: true,
    defaultBranch: null,
    description: null,
  };
}

export function gitIssue(overrides: Partial<GitIssue> = {}): GitIssue {
  return {
    number: "1",
    title: "预览页打不开",
    body: "",
    state: "open",
    labels: [],
    author: { id: "ext-1", name: "外部账号" },
    assignee: null,
    providerUpdatedAt: null,
    ...overrides,
  };
}

export function gitComment(overrides: Partial<GitComment> = {}): GitComment {
  return {
    id: "9001",
    issueNumber: "1",
    body: "评论正文",
    author: { id: "ext-9", name: "外部评论者" },
    providerUpdatedAt: null,
    ...overrides,
  };
}

export function gitLabel(overrides: Partial<GitLabel> = {}): GitLabel {
  return { id: "1", name: "bug", color: "ff0000", description: null, ...overrides };
}

/** 附件 fixture：`size` 是字节数（恢复核对按文件名 + 字节数认领未定的上传）。 */
export function gitAttachment(overrides: Partial<GitAttachment> = {}): GitAttachment {
  return { id: "8", name: "截图.png", size: 1024, createdAt: null, ...overrides };
}

/**
 * 带可信身份头的远端正文（用例侧的 fixture 工厂）。
 *
 * 必须经 `buildTicketBody` 生成：作者核验按「头部 `message_id` + 剥离身份头后的正文摘要」与本端归属行对号，
 * 手拼字符串的摘要必然对不上，用例会全部退化成「外部来源」而看不出真实缺陷。
 */
export function fixtureBody(input: {
  readonly messageId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly organizationId?: string;
  /** 传值时在身份头里写 `ticket.assignee_id`（指派后的远端正文形态）。 */
  readonly assigneeId?: string | null;
}): string {
  return buildTicketBody({
    header: {
      schema: 1,
      organizationId: input.organizationId ?? ORG_A,
      messageId: input.messageId,
      author: { id: input.authorId, name: input.authorName },
      ...(input.assigneeId === undefined || input.assigneeId === null
        ? {}
        : { ticket: { assigneeId: input.assigneeId } }),
    },
    body: input.body,
  });
}

/**
 * 落一条归属行（`ticket_messages`）：写入路径之外构造「本端承认的作者」只有这一条路。
 *
 * `body` 传**剥离身份头后的正文**——摘要与远端正文同源是同一次 `fixtureBody` 调用保证的。
 */
export async function seedOwnership(input: {
  readonly messages: TicketMessageRepository;
  readonly objectKind: "issue" | "comment";
  readonly providerObjectId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly projectId?: string;
}): Promise<TicketMessageRow> {
  return await input.messages.insert({
    projectId: input.projectId ?? PROJECT_A,
    objectKind: input.objectKind,
    providerObjectId: input.providerObjectId,
    messageId: input.messageId,
    authorId: input.authorId,
    authorNameSnapshot: input.authorName,
    bodyHash: hashBody(input.body),
    revision: 1,
  });
}

/** 标签目录的固定条目集；用例按需在行为里引用。 */
export const GIT_LABELS: readonly GitLabel[] = [
  gitLabel({ id: "1", name: "bug", color: "ff0000", description: "缺陷" }),
  gitLabel({ id: "2", name: "ui", color: "00ff00", description: null }),
];

/** Git 替身的可编程行为；未声明的动作抛「用例未声明」而不是编造数据。 */
export interface TicketGitBehaviour {
  getIssue?: (issueNumber: string) => Promise<GitIssue>;
  listIssues?: (query: GitIssueListQuery) => Promise<GitPage<GitIssue>>;
  createIssue?: (input: CreateIssueInput) => Promise<GitIssue>;
  editIssue?: (issueNumber: string, input: EditIssueInput) => Promise<GitIssue>;
  setLabels?: (issueNumber: string, labels: readonly string[]) => Promise<GitIssue>;
  listComments?: (issueNumber: string, query: GitListQuery) => Promise<GitPage<GitComment>>;
  getComment?: (commentId: string) => Promise<GitComment>;
  createComment?: (issueNumber: string, input: CreateCommentInput) => Promise<GitComment>;
  editComment?: (commentId: string, input: EditCommentInput) => Promise<GitComment>;
  listLabels?: () => Promise<readonly GitLabel[]>;
  createLabel?: (input: CreateLabelInput) => Promise<GitLabel>;
  editLabel?: (labelId: string, input: EditLabelInput) => Promise<GitLabel>;
  listAttachments?: (issueNumber: string) => Promise<readonly GitAttachment[]>;
  uploadAttachment?: (issueNumber: string, input: UploadAttachmentInput) => Promise<GitAttachment>;
  downloadAttachment?: (issueNumber: string, attachmentId: string) => Promise<GitAttachmentDownload>;
  /** 非 null 时 `createScopedClient` 用它抛错（模拟绑定不可用）。 */
  scopedClientError: unknown;
}

/** 一次远端调用的记录；`op` 是全量取值域，写操作由 {@link GitHarness.writeCalls} 过滤。 */
export type TicketGitCall =
  | { readonly op: "createScopedClient"; readonly bindingId: string }
  | { readonly op: "issues.get"; readonly issueNumber: string }
  | { readonly op: "issues.list"; readonly query: GitIssueListQuery }
  | { readonly op: "issues.create"; readonly input: CreateIssueInput }
  | { readonly op: "issues.edit"; readonly issueNumber: string; readonly input: EditIssueInput }
  | { readonly op: "issues.setLabels"; readonly issueNumber: string; readonly labels: readonly string[] }
  | { readonly op: "comments.list"; readonly issueNumber: string; readonly query: GitListQuery }
  | { readonly op: "comments.get"; readonly commentId: string }
  | { readonly op: "comments.create"; readonly issueNumber: string; readonly input: CreateCommentInput }
  | { readonly op: "comments.edit"; readonly commentId: string; readonly input: EditCommentInput }
  | { readonly op: "labels.list" }
  | { readonly op: "labels.create"; readonly input: CreateLabelInput }
  | { readonly op: "labels.edit"; readonly labelId: string; readonly input: EditLabelInput }
  | { readonly op: "attachments.list"; readonly issueNumber: string }
  | { readonly op: "attachments.upload"; readonly issueNumber: string; readonly input: UploadAttachmentInput }
  | {
      readonly op: "attachments.download";
      readonly issueNumber: string;
      readonly attachmentId: string;
    };

/** 会改变远端状态的调用；「零写入」类断言一律用它而不是逐 op 数。 */
const GIT_WRITE_OPS: ReadonlySet<TicketGitCall["op"]> = new Set([
  "issues.create",
  "issues.edit",
  "issues.setLabels",
  "comments.create",
  "comments.edit",
  "labels.create",
  "labels.edit",
  "attachments.upload",
]);

export interface GitHarness {
  readonly service: GitService;
  readonly behaviour: TicketGitBehaviour;
  readonly calls: TicketGitCall[];
  /** 写操作的调用集合（含参数）；用于「零写入」「只写一次」类断言。 */
  writeCalls(): readonly TicketGitCall[];
  /** 按 op 过滤调用；断言调用顺序与次数。 */
  ops(op: TicketGitCall["op"]): readonly TicketGitCall[];
}

export function createGitHarness(): GitHarness {
  const calls: TicketGitCall[] = [];
  const behaviour: TicketGitBehaviour = { scopedClientError: null };
  const required = <TArgs extends readonly unknown[], TResult>(
    method: ((...args: TArgs) => Promise<TResult>) | undefined,
    label: string,
  ): ((...args: TArgs) => Promise<TResult>) => {
    if (method === undefined) return async () => Promise.reject(new Error(`用例未声明 Git 操作 ${label}`));
    return method;
  };
  const scopedClient: GitScopedClient = {
    consumerId: "tickets",
    organizationId: ORG_A,
    repository: gitRepository().ref,
    repositories: {
      get: async () => gitRepository(),
      ensureIssuesEnabled: async () => gitRepository(),
    },
    issues: {
      async list(query) {
        const resolvedQuery = query ?? {};
        calls.push({ op: "issues.list", query: resolvedQuery });
        return await required(behaviour.listIssues, "issues.list")(resolvedQuery);
      },
      async get(issueNumber) {
        calls.push({ op: "issues.get", issueNumber });
        return await required(behaviour.getIssue, "issues.get")(issueNumber);
      },
      async create(input) {
        calls.push({ op: "issues.create", input });
        return await required(behaviour.createIssue, "issues.create")(input);
      },
      async edit(issueNumber, input) {
        calls.push({ op: "issues.edit", issueNumber, input });
        return await required(behaviour.editIssue, "issues.edit")(issueNumber, input);
      },
      async setLabels(issueNumber, labels) {
        calls.push({ op: "issues.setLabels", issueNumber, labels });
        return await required(behaviour.setLabels, "issues.setLabels")(issueNumber, labels);
      },
    },
    comments: {
      async list(issueNumber, query) {
        calls.push({ op: "comments.list", issueNumber, query: query ?? {} });
        return await required(behaviour.listComments, "comments.list")(issueNumber, query ?? {});
      },
      async get(commentId) {
        calls.push({ op: "comments.get", commentId });
        return await required(behaviour.getComment, "comments.get")(commentId);
      },
      async create(issueNumber, input) {
        calls.push({ op: "comments.create", issueNumber, input });
        return await required(behaviour.createComment, "comments.create")(issueNumber, input);
      },
      async edit(commentId, input) {
        calls.push({ op: "comments.edit", commentId, input });
        return await required(behaviour.editComment, "comments.edit")(commentId, input);
      },
    },
    labels: {
      async list() {
        calls.push({ op: "labels.list" });
        return await required(behaviour.listLabels, "labels.list")();
      },
      async create(input) {
        calls.push({ op: "labels.create", input });
        return await required(behaviour.createLabel, "labels.create")(input);
      },
      async edit(labelId, input) {
        calls.push({ op: "labels.edit", labelId, input });
        return await required(behaviour.editLabel, "labels.edit")(labelId, input);
      },
    },
    attachments: {
      async list(issueNumber) {
        calls.push({ op: "attachments.list", issueNumber });
        return await required(behaviour.listAttachments, "attachments.list")(issueNumber);
      },
      async upload(issueNumber, input) {
        calls.push({ op: "attachments.upload", issueNumber, input });
        return await required(behaviour.uploadAttachment, "attachments.upload")(issueNumber, input);
      },
      async download(issueNumber, attachmentId) {
        calls.push({ op: "attachments.download", issueNumber, attachmentId });
        return await required(behaviour.downloadAttachment, "attachments.download")(issueNumber, attachmentId);
      },
    },
  };
  const service: GitService = {
    connectionIds: ["primary"],
    async createScopedClient(input) {
      calls.push({ op: "createScopedClient", bindingId: input.bindingId });
      if (behaviour.scopedClientError !== null) throw behaviour.scopedClientError;
      return scopedClient;
    },
    admin: {
      async createPrivateRepository(_connectionId, input) {
        return gitRepository({ owner: input.owner, name: input.name });
      },
      async getRepository(_connectionId, ref) {
        return gitRepository({
          owner: ref.owner,
          name: ref.name,
          ...(ref.providerRepositoryId.length === 0 ? {} : { providerRepositoryId: ref.providerRepositoryId }),
        });
      },
      async ensureIssuesEnabled(_connectionId, ref) {
        return gitRepository({
          owner: ref.owner,
          name: ref.name,
          ...(ref.providerRepositoryId.length === 0 ? {} : { providerRepositoryId: ref.providerRepositoryId }),
        });
      },
      async bindExistingRepository(input) {
        return {
          id: BINDING_A,
          organizationId: input.organizationId,
          connectionId: input.connectionId,
          repository: {
            connectionId: input.connectionId,
            providerRepositoryId: input.providerRepositoryId,
            owner: input.owner,
            name: input.name,
          },
          allowedConsumers: input.allowedConsumers,
          status: "active",
        };
      },
      async getBinding() {
        return Promise.reject(new Error("用例未声明 Git 操作 admin.getBinding"));
      },
    },
  };
  return {
    service,
    behaviour,
    calls,
    writeCalls: () => calls.filter((call) => GIT_WRITE_OPS.has(call.op)),
    ops: (op) => calls.filter((call) => call.op === op),
  };
}

/** 本包全部领域服务与 Facade 的装配结果；用例按被断言的层取用。 */
export interface TicketHarness {
  readonly git: GitHarness;
  readonly constraints: ResourceQueryConstraint[];
  readonly projectStore: ProjectStore;
  readonly operationStore: OperationStore;
  readonly messageStore: MessageStore;
  readonly indexStore: IndexStore;
  readonly services: {
    readonly projects: TicketProjectService;
    readonly tickets: TicketService;
    readonly edit: TicketEditService;
    readonly comments: TicketCommentService;
    readonly labels: TicketLabelService;
    readonly attachments: TicketAttachmentService;
    readonly operations: TicketOperationService;
    readonly recovery: TicketRecoveryService;
  };
  readonly api: {
    readonly projects: TicketProjectFacadeApi;
    readonly tickets: TicketFacadeApi;
    readonly comments: TicketCommentFacadeApi;
    readonly labels: TicketLabelFacadeApi;
    readonly attachments: TicketAttachmentFacadeApi;
  };
}

/**
 * 装配被测的真实服务与 Facade（组合根 `createTicketsServerModule` 的测试同构）。
 *
 * `withRecovery` 默认 true：与组合根一致，`getOperation` 会对未定态触发一次核对；置 false 时退回 T02 的
 * 「只读账本」语义，供不关心核对触发的用例隔离出一条更短的路径。
 */
export function createTicketHarness(options: { readonly withRecovery?: boolean } = {}): TicketHarness {
  const withRecovery = options.withRecovery ?? true;
  const git = createGitHarness();
  const constraints: ResourceQueryConstraint[] = [];
  const accessControl = createFakeAccessControl(constraints);
  const identity = getIdentityDirectory();
  const projectStore = createProjectStore();
  const operationStore = createOperationStore();
  const messageStore = createMessageStore();
  const indexStore = createIndexStore();
  const operations = createTicketOperationService(operationStore.repository);
  const projectService = createTicketProjectService({
    projects: projectStore.repository,
    operations,
    git: git.service,
  });
  const ticketService = createTicketService({
    messages: messageStore.repository,
    index: indexStore.repository,
    operations,
    git: git.service,
  });
  const editService = createTicketEditService({
    messages: messageStore.repository,
    index: indexStore.repository,
    operations,
    git: git.service,
    identity,
  });
  const commentService = createTicketCommentService({
    messages: messageStore.repository,
    operations,
    git: git.service,
  });
  const labelService = createTicketLabelService({ operations, git: git.service });
  const attachmentService = createTicketAttachmentService({ operations, git: git.service });
  const recoveryService = createTicketRecoveryService({
    git: git.service,
    projects: projectStore.repository,
    operations: operationStore.repository,
    index: indexStore.repository,
    messages: messageStore.repository,
    identity,
  });
  const scopeStore = unusedScopeStore();
  return {
    git,
    constraints,
    projectStore,
    operationStore,
    messageStore,
    indexStore,
    services: {
      projects: projectService,
      tickets: ticketService,
      edit: editService,
      comments: commentService,
      labels: labelService,
      attachments: attachmentService,
      operations,
      recovery: recoveryService,
    },
    api: {
      projects: createTicketProjectFacade({
        accessControl,
        scopeStore,
        projects: projectService,
        operations,
        identity,
      }),
      tickets: createTicketFacade({
        accessControl,
        scopeStore,
        identity,
        projects: projectService,
        operations,
        service: ticketService,
        edit: editService,
        ...(withRecovery ? { recovery: recoveryService } : {}),
      }),
      comments: createTicketCommentFacade({
        accessControl,
        scopeStore,
        identity,
        projects: projectService,
        comments: commentService,
      }),
      labels: createTicketLabelFacade({
        accessControl,
        scopeStore,
        projects: projectService,
        labels: labelService,
      }),
      attachments: createTicketAttachmentFacade({
        accessControl,
        scopeStore,
        projects: projectService,
        attachments: attachmentService,
      }),
    },
  };
}

/**
 * 路由用例的会话守卫替身。
 *
 * 守卫由宿主注入，资源包不得依赖 `apps/server`，因此包内用例只能注入替身；替身只提供工厂注册路由所必需
 * 的形状（`actor` state 与同名 `sessionAuth` 宏），不复刻鉴权策略（cookie / Environment Secret / API Key
 * 的解析顺序归宿主用例）。`actor` 为 null 时模拟「已认证但没有组织上下文」，由路由层返回 401。
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */
export function createStubSessionAuthGuardPlugin(actor: ActorContext | null) {
  return new Elysia({ name: "test-tickets-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ actor: null as ActorContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({ store }: { store: { actor: ActorContext | null } }) => {
            store.actor = actor;
          },
        };
      },
    });
}

/**
 * 装配 `/web/tickets*` 路由（相对路径注册，与宿主 `/web` 前缀无关）并装入进程级模块槽位。
 *
 * 另挂宿主 error-handler 的**参数校验映射**：Elysia 对 schema 校验失败默认回 422 纯文本
 * （`{ status, message }` 之类），宿主 `apps/server/src/plugins/error-handler.ts` 会把它改写成
 * 400 + `{ error: { type: "VALIDATION_ERROR" } }`。包内不挂这段映射时，路径参数非法类的用例
 * 只能断言一个线上永远不会出现的 422；这里只映射这一条，不复制宿主的 AppError 分支——那部分
 * 由路由自己的错误映射表覆盖（`web-error.ts` 的文件头边界）。
 */
export function installTicketRoutes(harness: TicketHarness, actor: ActorContext | null) {
  installTicketsServerModule({
    resource: ticketProjectResource,
    projects: harness.api.projects,
    tickets: harness.api.tickets,
    comments: harness.api.comments,
    labels: harness.api.labels,
    attachments: harness.api.attachments,
    identity: getIdentityDirectory(),
  });
  return new Elysia()
    .onError({ as: "global" }, ({ error, set }) => {
      if (!(error instanceof ElysiaValidationError)) return;
      set.status = 400;
      return { error: { type: "VALIDATION_ERROR", message: "validation failed" } };
    })
    .use(createWebTicketRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin(actor) }));
}
