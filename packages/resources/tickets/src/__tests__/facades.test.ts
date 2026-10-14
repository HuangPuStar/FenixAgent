import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  BindExistingRepositoryInput,
  CreateIssueInput,
  GitIssue,
  GitRepository,
  GitRepositoryBindingView,
  GitScopedClient,
  GitService,
} from "@fenix/git/server";
import { GitError } from "@fenix/git/server";
import {
  type AccessControlModule,
  type ActorContext,
  ConflictError,
  ForbiddenError,
  type MemberRole,
  NotFoundError,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  ResourceAccessDeniedError,
  type ResourceQueryConstraint,
  type ResourceScopeStore,
  type UserDisplayInfo,
} from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import {
  initializeTestApplicationInfrastructure,
  resetAllStubs,
  stubIdentityDirectory,
} from "@fenix/platform-sdk/testing";
import { TicketCreateRequestSchema } from "../schemas/ticket.schema";
import { OperationNotFoundError, RepositoryOwnerMismatchError, TicketsPausedError } from "../server/errors";
import {
  createTicketFacade,
  type TicketFacadeApi,
  type TicketOperationRecoveryPort,
} from "../server/facades/ticket-facade";
import { createTicketProjectFacade, type TicketProjectFacadeApi } from "../server/facades/ticket-project-facade";
import type { TicketIndexRepository, TicketIndexRow } from "../server/repositories/ticket-index";
import type { TicketMessageRepository, TicketMessageRow } from "../server/repositories/ticket-messages";
import type { TicketOperationRepository, TicketOperationRow } from "../server/repositories/ticket-operations";
import type {
  ScopedTicketProjectRow,
  TicketProjectRepository,
  TicketProjectRow,
} from "../server/repositories/ticket-projects";
import { buildTicketBody, hashBody, parseTicketBody } from "../server/services/identity-header";
import { createTicketEditService } from "../server/services/ticket-edit-service";
import { createTicketOperationService, TICKET_OPERATION_STEP } from "../server/services/ticket-operation-service";
import { createTicketProjectService, reservedRepositoryName } from "../server/services/ticket-project-service";
import { createTicketService } from "../server/services/ticket-service";

/**
 * 工单 Facade 的**授权与编排**契约（backend contract §5 / §6 / §8.3）。
 *
 * 接缝说明：Facade 只经平台契约取事实，因此这里注入三样替身——授权实现（按 actor 的
 * `activeOrganizationId` 产出条件、按成员角色放行动作）、记录型仓储（受控读取按条件的组织归属过滤，
 * 复刻平台谓词「只匹配一个组织、要求成员关系成立」的语义）与 Git 服务替身（记录调用顺序、按用例给出
 * 响应）。领域服务与操作账本服务用**真实实现**：本文件要验证的正是 Facade 与它们之间的编排顺序，用替身
 * 顶掉它们会让「先声明幂等再出站」「成功终态与索引同事务」这些断言失去意义。
 *
 * 不在这里的部分：真实 SQL 的列、冲突目标与部分唯一索引归 `repositories.test.ts`；幂等与 202 的产生
 * 条件归 `tickets-create.test.ts`；HTTP 状态码与错误信封归路由层用例。
 */

const ORG_A = "org_alpha";
const ORG_B = "org_beta";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";
const BINDING_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IDEMPOTENCY_KEY = "idem-key-0001";
const FIXTURE_NOW = new Date("2026-10-12T08:00:00.000Z");

/** 事务替身：`runInTransaction` 需要 `transaction(callback)` 与事务句柄的 `execute`（语句超时设置）。 */
const TRANSACTION_HANDLE = { execute: async () => undefined };
const DATABASE_STUB = {
  execute: async () => undefined,
  transaction: async <TResult>(run: (handle: typeof TRANSACTION_HANDLE) => Promise<TResult>): Promise<TResult> =>
    run(TRANSACTION_HANDLE),
};

/** 构造可信主体；`organizationId` 缺省表示凭据没有组织上下文。 */
function testActor(userId: string, organizationId: string | undefined, role: MemberRole = "member"): ActorContext {
  return {
    kind: "user",
    userId,
    ...(organizationId === undefined ? {} : { activeOrganizationId: organizationId }),
    memberships: organizationId === undefined ? [] : [{ organizationId, role }],
  };
}

/** 当前组织里的成员角色；授权实现的判定依据（actor 是成员关系的全量投影）。 */
function roleInActiveOrg(actor: ActorContext): MemberRole | undefined {
  return actor.memberships.find((membership) => membership.organizationId === actor.activeOrganizationId)?.role;
}

/** 声明身份目录的展示投影；未声明的 id 走空投影（视图回退写入期快照）。 */
function stubUsers(users: readonly { readonly id: string; readonly name: string }[]): void {
  const byId = new Map<string, UserDisplayInfo>(
    users.map((user) => [user.id, { id: user.id, name: user.name, email: `${user.id}@example.test` }]),
  );
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
  });
}

/**
 * 授权实现替身：条件只匹配 actor 的 active organization，组织内成员只获得 `read`。
 *
 * 角色 → 动作的推导规则本身由 `@fenix/access-control` 的用例覆盖；这里固定的两件事是 Facade 依赖的
 * 契约形状：`createListConstraint` 产出的条件内嵌组织归属（谓词的唯一输入），以及管理动作
 * （`resolveInitialScope` / `authorize(update)`）对成员拒绝。
 */
function createFakeAccessControl(constraints: ResourceQueryConstraint[]): AccessControlModule {
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
function constraintOrg(access: ResourceQueryConstraint): string | undefined {
  const payload = access[RESOURCE_QUERY_CONSTRAINT_PAYLOAD] as { readonly organizationId?: string } | undefined;
  return payload?.organizationId;
}

/** Facade 不使用的 scope store：任何调用都视为行为回归。 */
function unusedScopeStore(): ResourceScopeStore {
  const unused = async (): Promise<never> => {
    throw new Error("Facade 的授权编排不应触碰 scope store");
  };
  return { initialize: unused, getMany: unused, update: unused, remove: unused };
}

function projectRow(seed: Partial<TicketProjectRow> & { readonly id: string; readonly organizationId: string }) {
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

interface ProjectStore {
  readonly rows: TicketProjectRow[];
  /** 受控读取收到的条件；用于断言「条件原样下推」。 */
  readonly accesses: ResourceQueryConstraint[];
  readonly repository: TicketProjectRepository;
  seed(input: Partial<TicketProjectRow> & { readonly id: string; readonly organizationId: string }): TicketProjectRow;
}

/** 记录型项目仓储：受控读取按条件的组织归属过滤，无授权读取按主键直接命中。 */
function createProjectStore(): ProjectStore {
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
          // 归属列被钉在原值上（与生产仓储的冲突更新集合一致），坐标快照则刷新。
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

interface OperationStore {
  readonly rows: TicketOperationRow[];
  readonly repository: TicketOperationRepository;
}

/**
 * 记录型操作账本：复刻 `claim` 的唯一键裁决、`markDispatching` 的条件更新与 `hasInFlightTarget`
 * 的对象在途谓词（SQL 侧见 repositories.test.ts）。
 */
function createOperationStore(): OperationStore {
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
      async markUncertain({ operationId, step }) {
        const row = require(operationId);
        row.status = "uncertain";
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
      // 按主键加锁读（`SELECT ... FOR UPDATE` 的替身）：单进程测试没有并发，语义与仓储一致。
      async findByIdForUpdate({ operationId }) {
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

interface MessageStore {
  readonly rows: TicketMessageRow[];
  readonly repository: TicketMessageRepository;
}

/** 记录型归属仓储：三个唯一索引（对象、message_id、项目内对象）的冲突一律抛出，不做静默改写。 */
function createMessageStore(): MessageStore {
  const rows: TicketMessageRow[] = [];
  return {
    rows,
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

interface IndexStore {
  readonly rows: TicketIndexRow[];
  /** 列表查询入参；用于断言条件与分页下推。 */
  readonly queries: Array<{ readonly projectId: string; readonly limit: number; readonly cursor?: string }>;
  readonly repository: TicketIndexRepository;
  seed(input: Partial<TicketIndexRow> & { readonly projectId: string; readonly issueNumber: string }): TicketIndexRow;
}

/** 记录型索引仓储：排序与游标语义照生产（工单号数值降序、游标为排他上界）。 */
function createIndexStore(): IndexStore {
  const rows: TicketIndexRow[] = [];
  const queries: IndexStore["queries"] = [];
  const seed = (input: Partial<TicketIndexRow> & { readonly projectId: string; readonly issueNumber: string }) => {
    const row = {
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
  return {
    rows,
    queries,
    seed,
    repository: {
      async upsertIssue(input) {
        const existing = rows.find((row) => row.projectId === input.projectId && row.issueNumber === input.issueNumber);
        if (existing !== undefined) {
          existing.title = input.title;
          existing.state = input.state;
          existing.authorId = input.authorId;
          existing.authorName = input.authorName;
          existing.labelIds = [...input.labelIds];
          existing.contentVersion = input.contentVersion;
          return existing;
        }
        return seed({
          projectId: input.projectId,
          issueNumber: input.issueNumber,
          title: input.title,
          state: input.state,
          authorId: input.authorId,
          authorName: input.authorName,
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
        });
        return rows
          .filter((row) => row.projectId === input.projectId)
          .filter((row) => input.cursor === undefined || BigInt(row.issueNumber) < BigInt(input.cursor))
          .sort((left, right) => (BigInt(right.issueNumber) < BigInt(left.issueNumber) ? -1 : 1))
          .slice(0, input.limit);
      },
      async findByIssueNumber({ projectId, issueNumber }) {
        return rows.find((row) => row.projectId === projectId && row.issueNumber === issueNumber);
      },
      // T02 用例不覆盖平台管理面的跨组织读取（那是 `/api/system/tickets` 的路径）；显式抛错而不是返回空页，
      // 免得将来误用时得到一份「看起来正常」的空结果。
      async listPlatformPage() {
        throw new Error("平台管理面读取不在本文件的覆盖范围内");
      },
      async countByProject(projectId) {
        return rows.filter((row) => row.projectId === projectId).length;
      },
    },
  };
}

/** Git 服务替身的外部响应；用例按需覆盖单个动作，未覆盖时给出「未声明」错误而不是编造数据。 */
interface GitBehaviour {
  createRepository: (
    connectionId: string,
    input: { readonly owner: string; readonly name: string },
  ) => Promise<GitRepository>;
  getIssue: (issueNumber: string) => Promise<GitIssue>;
  createIssue: (input: CreateIssueInput) => Promise<GitIssue>;
  scopedClientError: unknown;
}

function gitRepository(overrides: Partial<GitRepository["ref"]> = {}): GitRepository {
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

function gitIssue(overrides: Partial<GitIssue> = {}): GitIssue {
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

function bindingView(input: BindExistingRepositoryInput): GitRepositoryBindingView {
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
}

function createGitHarness() {
  const calls: string[] = [];
  const createIssueInputs: CreateIssueInput[] = [];
  const boundInputs: BindExistingRepositoryInput[] = [];
  const behaviour: GitBehaviour = {
    createRepository: async (_connectionId, input) => gitRepository({ owner: input.owner, name: input.name }),
    getIssue: async () => {
      throw new Error("用例未声明 issues.get 的返回值");
    },
    createIssue: async () => {
      throw new Error("用例未声明 issues.create 的返回值");
    },
    scopedClientError: null,
  };
  const unused = async (operation: string): Promise<never> => {
    throw new Error(`用例未声明 Git 操作 ${operation}`);
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
      list: async () => unused("issues.list"),
      get: async (issueNumber) => {
        calls.push(`issues.get:${issueNumber}`);
        return behaviour.getIssue(issueNumber);
      },
      create: async (input) => {
        calls.push("issues.create");
        createIssueInputs.push(input);
        return behaviour.createIssue(input);
      },
      edit: async () => unused("issues.edit"),
      setLabels: async () => unused("issues.setLabels"),
    },
    comments: {
      list: async () => unused("comments.list"),
      get: async () => unused("comments.get"),
      create: async () => unused("comments.create"),
      edit: async () => unused("comments.edit"),
    },
    labels: {
      list: async () => unused("labels.list"),
      create: async () => unused("labels.create"),
      edit: async () => unused("labels.edit"),
    },
    // 附件不在本文件的被测面内（T05 的用例在 `ticket-attachments.test.ts`）；这里只补形状。
    attachments: {
      list: async () => unused("attachments.list"),
      upload: async () => unused("attachments.upload"),
      download: async () => unused("attachments.download"),
    },
  };
  const service: GitService = {
    connectionIds: ["primary"],
    async createScopedClient(input) {
      calls.push(`createScopedClient:${input.bindingId}`);
      if (behaviour.scopedClientError !== null) throw behaviour.scopedClientError;
      return scopedClient;
    },
    admin: {
      async createPrivateRepository(connectionId, input) {
        calls.push("admin.createPrivateRepository");
        return behaviour.createRepository(connectionId, { owner: input.owner, name: input.name });
      },
      async getRepository(_connectionId, ref) {
        calls.push("admin.getRepository");
        return gitRepository({
          owner: ref.owner,
          name: ref.name,
          ...(ref.providerRepositoryId.length === 0 ? {} : { providerRepositoryId: ref.providerRepositoryId }),
        });
      },
      async ensureIssuesEnabled(_connectionId, ref) {
        calls.push("admin.ensureIssuesEnabled");
        return gitRepository({
          owner: ref.owner,
          name: ref.name,
          ...(ref.providerRepositoryId.length === 0 ? {} : { providerRepositoryId: ref.providerRepositoryId }),
        });
      },
      async bindExistingRepository(input) {
        calls.push("admin.bindExistingRepository");
        boundInputs.push(input);
        return bindingView(input);
      },
      async getBinding() {
        return unused("admin.getBinding");
      },
    },
  };
  return { service, calls, createIssueInputs, boundInputs, behaviour };
}

interface Harness {
  readonly projects: TicketProjectFacadeApi;
  readonly tickets: TicketFacadeApi;
  readonly git: ReturnType<typeof createGitHarness>;
  readonly projectStore: ProjectStore;
  readonly operationStore: OperationStore;
  readonly messageStore: MessageStore;
  readonly indexStore: IndexStore;
}

/** 装配被测的两条 Facade：真实的领域服务与操作账本服务 + 注入的仓储与 Git 替身。 */
function createHarness(options: { readonly recovery?: TicketOperationRecoveryPort } = {}): Harness {
  const git = createGitHarness();
  const constraints: ResourceQueryConstraint[] = [];
  const accessControl = createFakeAccessControl(constraints);
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
  const edit = createTicketEditService({
    messages: messageStore.repository,
    index: indexStore.repository,
    operations,
    git: git.service,
    identity: getIdentityDirectory(),
  });
  return {
    git,
    projectStore,
    operationStore,
    messageStore,
    indexStore,
    projects: createTicketProjectFacade({
      accessControl,
      scopeStore: unusedScopeStore(),
      projects: projectService,
      operations,
      identity: getIdentityDirectory(),
    }),
    tickets: createTicketFacade({
      accessControl,
      scopeStore: unusedScopeStore(),
      identity: getIdentityDirectory(),
      projects: projectService,
      operations,
      service: ticketService,
      edit,
      // 缺省不装配恢复核对：既有用例因此走 T02 的「只读账本」语义。
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    }),
  };
}

beforeEach(() => {
  resetAllStubs();
  // 应用基础设施只允许初始化一次；`runInTransaction`（advisory lock 与成功终态事务）经它取事务句柄。
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
});

describe("工单 Facade — 组织边界", () => {
  // 跨组织的 projectId 在列表、详情与创建上都与「不存在」同形返回 404，且不产生任何上游调用。
  test("跨组织 projectId 在三条读写路径上都返回 404", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A });
    const outsider = testActor("user_beta", ORG_B, "owner");

    await expect(harness.tickets.list(outsider, PROJECT_A, {})).rejects.toThrow(NotFoundError);
    await expect(harness.tickets.get(outsider, PROJECT_A, "1")).rejects.toThrow(NotFoundError);
    await expect(
      harness.tickets.create(outsider, PROJECT_A, { title: "标题", body: "正文" }, IDEMPOTENCY_KEY),
    ).rejects.toThrow(NotFoundError);

    expect(harness.git.calls).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 受控读取必须把授权条件原样交给平台查询端口：本层不得自行拼接组织条件或过滤可见集合。
  test("受控读取把授权条件原样下推，且条件只覆盖当前组织", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A });
    harness.projectStore.seed({ id: PROJECT_B, organizationId: ORG_B });

    const overview = await harness.projects.list(testActor("user_member", ORG_A, "member"));

    expect(overview.projects.map((project) => project.id)).toEqual([PROJECT_A]);
    expect(harness.projectStore.accesses.length).toBeGreaterThan(0);
    expect(harness.projectStore.accesses.every((access) => constraintOrg(access) === ORG_A)).toBe(true);
  });

  // 同组织成员可查看该项目下的全部工单（不按创建者或作者过滤），列表条件与分页原样下推给索引查询。
  test("同组织成员可读全部工单且列表条件与分页下推", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A });
    harness.indexStore.seed({
      projectId: PROJECT_A,
      issueNumber: "7",
      title: "他人提交的工单",
      authorId: "user_other",
      authorName: "李四",
    });
    harness.indexStore.seed({
      projectId: PROJECT_A,
      issueNumber: "6",
      title: "外部直写",
      authorId: null,
      authorName: "远端账号",
    });
    harness.indexStore.seed({ projectId: PROJECT_B, issueNumber: "9", title: "别组织的工单" });
    stubUsers([{ id: "user_other", name: "李四改名后" }]);

    const page = await harness.tickets.list(testActor("user_member", ORG_A, "member"), PROJECT_A, { limit: 500 });

    expect(page.items.map((item) => item.issueNumber)).toEqual(["7", "6"]);
    expect(page.items[0]?.author).toEqual({ id: "user_other", name: "李四改名后", source: "aos" });
    expect(page.items[1]?.author).toEqual({ id: null, name: "远端账号", source: "external" });
    // limit 收敛到上限 100；projectId 取受控读取解析出的行，不是把请求参数直接透传。
    expect(harness.indexStore.queries).toEqual([{ projectId: PROJECT_A, limit: 100 }]);
    expect(harness.git.calls).toEqual([]);
  });

  // 游标格式非法时提前拒绝：非法值进不了索引查询的 `::bigint`，也不需要一次数据库往返。
  test("列表游标非法时报 400 且不查询索引", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A });

    await expect(
      harness.tickets.list(testActor("user_member", ORG_A, "member"), PROJECT_A, { cursor: "0" }),
    ).rejects.toThrow("cursor 必须是正整数");
    expect(harness.indexStore.queries).toEqual([]);
  });
});

describe("工单 Facade — 角色与管理动作", () => {
  // 组织级三态由项目行推导：无项目 → unconfigured，有可用默认 → ready，默认被暂停 → paused。
  test("项目总览的三态与可用默认项目解析", async () => {
    const harness = createHarness();
    const member = testActor("user_member", ORG_A, "member");

    expect(await harness.projects.list(member)).toEqual({
      projects: [],
      defaultProjectId: null,
      state: "unconfigured",
    });

    const primary = harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, isDefault: true });
    harness.projectStore.seed({ id: PROJECT_B, organizationId: ORG_B, repositoryRef: BINDING_B, isDefault: true });
    const ready = await harness.projects.list(member);
    expect(ready.state).toBe("ready");
    expect(ready.defaultProjectId).toBe(primary.id);

    // 暂停组织工单 = 把默认项目置 paused：项目行与绑定都保留，只是不再有可用的默认项目。
    await harness.projects.setDefault(testActor("user_admin", ORG_A, "owner"), { status: "paused" });
    const paused = await harness.projects.list(member);
    expect(paused.state).toBe("paused");
    expect(paused.defaultProjectId).toBeNull();
    expect(paused.projects[0]?.isDefault).toBe(true);
  });

  // 组织内成员的管理动作（开通项目、切换默认）一律 403；跨组织目标先于角色判定收敛为 404。
  test("成员管理动作 403、跨组织目标 404、暂停目标设默认 409", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, isDefault: true });
    const member = testActor("user_member", ORG_A, "member");
    const owner = testActor("user_admin", ORG_A, "owner");

    await expect(
      harness.projects.provisionDefault(
        member,
        { connectionId: "primary", mode: "create", repository: { owner: "aos-bot" } },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(ForbiddenError);
    await expect(harness.projects.setDefault(member, { projectId: PROJECT_A })).rejects.toThrow(ForbiddenError);
    expect(harness.git.calls).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);

    await expect(
      harness.projects.setDefault(testActor("user_beta", ORG_B, "owner"), { projectId: PROJECT_A }),
    ).rejects.toThrow(NotFoundError);

    await harness.projects.setDefault(owner, { status: "paused" });
    await expect(harness.projects.setDefault(owner, { projectId: PROJECT_A })).rejects.toThrow(ConflictError);
  });

  // 暂停只停写：创建工单报 503 且零上游调用、零账本行，而列表照常可用（保留绑定与历史数据）。
  test("暂停项目的创建报 503 且零上游调用", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, status: "paused" });
    const owner = testActor("user_admin", ORG_A, "owner");

    const failure = await harness.tickets
      .create(owner, PROJECT_A, { title: "标题", body: "正文" }, IDEMPOTENCY_KEY)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TicketsPausedError);
    expect(failure).toMatchObject({ code: "TICKETS_PAUSED", statusCode: 503 });
    expect(harness.git.calls).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
    expect((await harness.tickets.list(owner, PROJECT_A, {})).items).toEqual([]);
  });
});

describe("工单 Facade — 作者正确性", () => {
  // 作者与组织只能来自可信上下文：请求体里伪造的 author / message_id / organizationId 既不进身份头也不进账本。
  test("请求体伪造的作者与组织不进入身份头与归属记录", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A });
    stubUsers([{ id: "user_member", name: "张三" }]);
    harness.git.behaviour.createIssue = async (input) =>
      gitIssue({ number: "42", title: "预览页打不开", body: input.body });

    const forged = {
      title: "预览页打不开",
      body: "正文",
      author: { id: "user_attacker" },
      messageId: "msg_forged",
      organizationId: ORG_B,
    };
    const outcome = await harness.tickets.create(
      testActor("user_member", ORG_A, "member"),
      PROJECT_A,
      forged,
      IDEMPOTENCY_KEY,
    );
    if (outcome.kind !== "created") throw new Error(`期望创建成功，实际是 ${outcome.kind}`);

    const sent = harness.git.createIssueInputs[0];
    const parsed = parseTicketBody(sent?.body ?? "");
    expect(parsed.header?.organizationId).toBe(ORG_A);
    expect(parsed.header?.author).toEqual({ id: "user_member", name: "张三" });
    expect(parsed.header?.messageId.startsWith("msg_")).toBe(true);
    expect(parsed.header?.messageId).not.toBe("msg_forged");
    expect(parsed.body.trimEnd()).toBe("正文");

    const operation = harness.operationStore.rows[0];
    expect(operation?.organizationId).toBe(ORG_A);
    expect(operation?.actorId).toBe("user_member");
    expect(operation?.messageId).toBe(parsed.header?.messageId ?? null);
    expect(harness.messageStore.rows[0]?.authorId).toBe("user_member");
    expect(outcome.ticket.author).toEqual({ id: "user_member", name: "张三", source: "aos" });
    // 协议层的第二道闸：身份字段在请求体里根本不存在，多传即 400（不是被静默剥掉）。
    expect(TicketCreateRequestSchema.safeParse(forged).success).toBe(false);
  });

  // 详情作者只在身份头、归属记录与正文摘要三者同时吻合时判为 AOS；摘要或 message_id 不符即外部来源且 id 为 null。
  test("详情作者核验：三者吻合为 aos，摘要或 message_id 不符为 external", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A });
    harness.messageStore.rows.push({
      id: randomUUID(),
      projectId: PROJECT_A,
      objectKind: "issue",
      providerObjectId: "42",
      messageId: "msg_1",
      authorId: "user_member",
      authorNameSnapshot: "写入时快照名",
      bodyHash: hashBody("正文"),
      revision: 1,
      lastEditorId: null,
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    });
    stubUsers([{ id: "user_member", name: "改名后的张三" }]);
    const member = testActor("user_member", ORG_A, "member");
    const header = {
      schema: 1 as const,
      organizationId: ORG_A,
      messageId: "msg_1",
      author: { id: "user_attacker", name: "冒名者" },
    };
    harness.git.behaviour.getIssue = async () =>
      gitIssue({ number: "42", body: buildTicketBody({ header, body: "正文" }) });

    const matched = await harness.tickets.get(member, PROJECT_A, "42");
    // 头部自填的 author 不被采信：作者取归属记录，展示名取身份目录当前值。
    expect(matched.author).toEqual({ id: "user_member", name: "改名后的张三", source: "aos" });
    expect(matched.body.trimEnd()).toBe("正文");

    harness.git.behaviour.getIssue = async () =>
      gitIssue({ number: "42", body: buildTicketBody({ header, body: "正文被改过" }) });
    expect((await harness.tickets.get(member, PROJECT_A, "42")).author).toEqual({
      id: null,
      name: "外部账号",
      source: "external",
    });

    harness.git.behaviour.getIssue = async () =>
      gitIssue({
        number: "42",
        body: buildTicketBody({ header: { ...header, messageId: "msg_other" }, body: "正文" }),
      });
    expect((await harness.tickets.get(member, PROJECT_A, "42")).author).toEqual({
      id: null,
      name: "外部账号",
      source: "external",
    });
  });

  // 工单号在所属项目内不存在时映射 404（上游 NOT_FOUND），不伪装成托管平台不可用。
  test("详情编号不存在映射 404", async () => {
    const harness = createHarness();
    harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A });
    harness.git.behaviour.getIssue = async () => {
      throw new GitError("NOT_FOUND", "工单不存在");
    };

    await expect(harness.tickets.get(testActor("user_member", ORG_A, "member"), PROJECT_A, "404")).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("工单 Facade — 开通编排", () => {
  // 开通顺序固定为建私有仓库 → 开启 Issues → 写绑定 → 写项目：绑定用服务账号凭据引用与工单消费者授权集合。
  test("create 模式按序建仓、开启 Issues、写绑定与项目", async () => {
    const harness = createHarness();
    harness.git.behaviour.createRepository = async (_connectionId, input) =>
      gitRepository({ owner: input.owner, name: input.name, providerRepositoryId: "repo-upstream" });

    const outcome = await harness.projects.provisionDefault(
      testActor("user_admin", ORG_A, "owner"),
      { connectionId: "primary", mode: "create", repository: { owner: "aos-bot" } },
      IDEMPOTENCY_KEY,
    );
    if (outcome.kind !== "ok") throw new Error(`期望开通成功，实际是 ${outcome.kind}`);

    expect(harness.git.calls).toEqual([
      "admin.createPrivateRepository",
      "admin.ensureIssuesEnabled",
      "admin.bindExistingRepository",
    ]);
    const bound = harness.git.boundInputs[0];
    expect(bound?.organizationId).toBe(ORG_A);
    expect(bound?.credentialRef).toBe("{env:AOS_GIT_SERVICE_TOKEN}");
    expect(bound?.allowedConsumers.tickets).toContain("issues.write");
    expect(bound?.name.startsWith("aos-tickets-")).toBe(true);
    expect(bound?.name).toBe(reservedRepositoryName(ORG_A));
    // 绑定坐标取上游响应，不采信请求体里的任何自报值（bind 模式同样先解析再登记）。
    expect(bound?.providerRepositoryId).toBe("repo-upstream");

    // 上游坐标优先：项目行的 providerRepositoryId 取创建响应，不采信请求体里的任何自报值。
    const project = harness.projectStore.rows[0];
    expect(project?.providerRepositoryId).toBe("repo-upstream");
    expect(project?.createdBy).toBe("user_admin");
    expect(outcome.project.isDefault).toBe(true);
    expect(harness.operationStore.rows[0]).toMatchObject({ status: "succeeded", step: "project_ready" });
  });

  // 建仓响应的 owner 与请求声明不一致（决策 D1）：当场失败、不写绑定、不写项目，操作落 failed 且重放不再触碰远端。
  test("owner 回读不一致时不落库且同键重放不再出站", async () => {
    const harness = createHarness();
    harness.git.behaviour.createRepository = async (_connectionId, input) =>
      gitRepository({ owner: "someone-else", name: input.name });
    const owner = testActor("user_admin", ORG_A, "owner");
    const input = { connectionId: "primary", mode: "create", repository: { owner: "aos-bot" } } as const;

    const failure = await harness.projects
      .provisionDefault(owner, input, IDEMPOTENCY_KEY)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryOwnerMismatchError);
    expect(failure).toMatchObject({ code: "GIT_OWNER_MISMATCH", statusCode: 400 });
    expect(harness.git.calls).toEqual(["admin.createPrivateRepository"]);
    expect(harness.projectStore.rows).toEqual([]);
    expect(harness.operationStore.rows[0]).toMatchObject({ status: "failed", step: "owner_mismatch" });

    await expect(harness.projects.provisionDefault(owner, input, IDEMPOTENCY_KEY)).rejects.toMatchObject({
      code: "GIT_OWNER_MISMATCH",
    });
    expect(harness.git.calls).toEqual(["admin.createPrivateRepository"]);
  });

  // 操作账本只对操作者本人可见（决策 D5）：他人、跨组织与无组织上下文一律 404，本人可读到状态与目标。
  test("操作账本仅操作者本人可见", async () => {
    const harness = createHarness();
    const owner = testActor("user_admin", ORG_A, "owner");
    const outcome = await harness.projects.provisionDefault(
      owner,
      { connectionId: "primary", mode: "create", repository: { owner: "aos-bot" } },
      IDEMPOTENCY_KEY,
    );
    if (outcome.kind !== "ok") throw new Error(`期望开通成功，实际是 ${outcome.kind}`);

    const viewed = await harness.tickets.getOperation(owner, outcome.operationId);
    expect(viewed).toMatchObject({
      kind: "project.provision",
      status: "succeeded",
      targetId: outcome.project.id,
    });

    await expect(
      harness.tickets.getOperation(testActor("user_member", ORG_A, "member"), outcome.operationId),
    ).rejects.toThrow(OperationNotFoundError);
    await expect(
      harness.tickets.getOperation(testActor("user_beta", ORG_B, "owner"), outcome.operationId),
    ).rejects.toThrow(OperationNotFoundError);
    await expect(harness.tickets.getOperation(testActor("user_admin", undefined), outcome.operationId)).rejects.toThrow(
      OperationNotFoundError,
    );
  });
});

describe("工单 Facade — 操作读路径上的恢复核对", () => {
  /** 未定状态的账本行：`dispatching` 表示崩溃/在途残留，是恢复核对的触发条件之一（§8.1）。 */
  function operationRow(overrides: Partial<TicketOperationRow> = {}): TicketOperationRow {
    return {
      id: randomUUID(),
      organizationId: ORG_A,
      projectId: PROJECT_A,
      actorId: "user_member",
      kind: "issue.create",
      targetId: null,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestHash: "hash-1",
      messageId: "msg_pending",
      expectedVersion: null,
      intent: { title: "预览页打不开" },
      step: TICKET_OPERATION_STEP.dispatching,
      status: "dispatching",
      result: null,
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
      ...overrides,
    };
  }

  // 未定状态触发一次恢复核对：返回给调用方的是核对后的账本行，而不是核对前的旧快照（§8.1）。
  test("未定状态触发恢复核对并返回核对结果", async () => {
    const row = operationRow();
    const reconciled: TicketOperationRow = { ...row, status: "succeeded", step: "index_written", targetId: "42" };
    const seen: string[] = [];
    const harness = createHarness({
      recovery: {
        async reconcile({ organizationId, actorId, operationId }) {
          seen.push(`${organizationId}:${actorId}:${operationId}`);
          return { operation: reconciled };
        },
      },
    });
    harness.operationStore.rows.push(row);

    const viewed = await harness.tickets.getOperation(testActor("user_member", ORG_A, "member"), row.id);

    expect(seen).toEqual([`${ORG_A}:user_member:${row.id}`]);
    expect(viewed).toMatchObject({ operationId: row.id, status: "succeeded", targetId: "42" });
  });

  // 终态不触发核对：已定论的操作再回源只会白花一次上游调用（§8.1 只核对 dispatching / uncertain）。
  test("终态操作不触发恢复核对", async () => {
    const harness = createHarness({
      recovery: {
        async reconcile() {
          throw new Error("终态操作不应触发恢复核对");
        },
      },
    });
    harness.operationStore.rows.push(operationRow({ status: "succeeded", step: "index_written" }));

    const viewed = await harness.tickets.getOperation(
      testActor("user_member", ORG_A, "member"),
      harness.operationStore.rows[0]?.id ?? "",
    );

    expect(viewed.status).toBe("succeeded");
  });
});
