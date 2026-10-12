import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CreateIssueInput, GitIssue, GitScopedClient, GitService } from "@fenix/git/server";
import { GitError } from "@fenix/git/server";
import {
  type AccessControlModule,
  type ActorContext,
  ConflictError,
  NotFoundError,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceQueryConstraint,
  type ResourceScopeStore,
  ValidationError,
} from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { TICKET_PROJECT_RESOURCE_TYPE } from "../server/access/ticket-project-resource";
import { IdempotencyConflictError, VersionConflictError } from "../server/errors";
import { createTicketFacade, type TicketFacadeApi } from "../server/facades/ticket-facade";
import type { TicketIndexRepository, TicketIndexRow } from "../server/repositories/ticket-index";
import type { TicketMessageRepository, TicketMessageRow } from "../server/repositories/ticket-messages";
import type { TicketOperationRepository, TicketOperationRow } from "../server/repositories/ticket-operations";
import type { TicketProjectRow } from "../server/repositories/ticket-projects";
import { mapTicketError, type TicketStatusWriter } from "../server/routes/web/web-error";
import { computeContentVersion } from "../server/services/content-version";
import { createTicketOperationService } from "../server/services/ticket-operation-service";
import type { TicketProjectService } from "../server/services/ticket-project-service";
import { hashTicketRequest, issueCreateTargetPath } from "../server/services/ticket-request-hash";
import {
  createTicketService,
  type TicketCreateIssueInput,
  type TicketService,
} from "../server/services/ticket-service";

/**
 * 建工单路径的**可靠性契约**（backend contract §8.2 / §8.3）：幂等、202 的三个产生条件、上游确定失败的收敛。
 *
 * 接缝说明：领域服务与操作账本服务用真实实现（要验证的正是它们的裁决顺序），只把仓储与 Git 换成记录型替身。
 * 因此「先声明幂等再出站」「成功终态与索引/归属同事务」「重放不二次创建」这些断言检查的是真实代码路径，
 * 而不是替身的行为。
 *
 * 与 `facades.test.ts` 的分工：那里验证授权、作者归属与开通编排；本文件验证一次用户动作最多产生一次远端
 * 写入，以及未定结果如何变成调用方看到的 202。
 *
 * T02 的边界（不在本文件判定）：`VERSION_CONFLICT` 本文只覆盖**协议映射**与指纹可判别性——真正的过期版本
 * 判定点在 T03 的编辑/评论路径（§8.4/§8.6），T02 的创建路径恒以 `expectedVersion: null` 声明操作。
 */

const ORG_A = "org_alpha";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const BINDING_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDEMPOTENCY_KEY = "idem-key-0001";
const FIXTURE_NOW = new Date("2026-10-12T08:00:00.000Z");

/** 事务替身：`runInTransaction` 需要 `transaction(callback)` 与事务句柄的 `execute`（语句超时设置）。 */
const TRANSACTION_HANDLE = { execute: async () => undefined };
const DATABASE_STUB = {
  execute: async () => undefined,
  transaction: async <TResult>(run: (handle: typeof TRANSACTION_HANDLE) => Promise<TResult>): Promise<TResult> =>
    run(TRANSACTION_HANDLE),
};

/** 请求入参替身：除显式覆盖外都是同一份内容（同键同内容的判据是规范化的请求指纹）。 */
function createInput(overrides: Partial<TicketCreateIssueInput> = {}): TicketCreateIssueInput {
  return {
    organizationId: ORG_A,
    projectId: PROJECT_A,
    bindingId: BINDING_A,
    actorId: "user_member",
    authorName: "张三",
    title: "预览页打不开",
    body: "正文",
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function gitIssue(overrides: Partial<GitIssue> = {}): GitIssue {
  return {
    number: "42",
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

interface OperationStore {
  readonly rows: TicketOperationRow[];
  readonly repository: TicketOperationRepository;
}

/** 记录型操作账本：复刻 `claim` 的唯一键裁决与 `markDispatching` 的条件更新语义（SQL 侧见 repositories.test.ts）。 */
function createOperationStore(): OperationStore {
  const rows: TicketOperationRow[] = [];
  const require = (operationId: string): TicketOperationRow => {
    const row = rows.find((candidate) => candidate.id === operationId);
    if (row === undefined) throw new Error("替身账本里没有这条操作");
    return row;
  };
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
          targetId: null,
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
        const row = rows.find((candidate) => candidate.id === operationId);
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
    },
  };
}

interface MessageStore {
  readonly rows: TicketMessageRow[];
  readonly repository: TicketMessageRepository;
  /** 让后续 insert 失败：模拟 `ticket_messages` 的唯一索引冲突与本地落库故障。 */
  failInsertWith(error: Error | null): void;
}

function createMessageStore(): MessageStore {
  const rows: TicketMessageRow[] = [];
  let pendingError: Error | null = null;
  return {
    rows,
    failInsertWith(error) {
      pendingError = error;
    },
    repository: {
      async insert(input) {
        if (pendingError !== null) throw pendingError;
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
    },
  };
}

interface IndexStore {
  readonly rows: TicketIndexRow[];
  readonly repository: TicketIndexRepository;
}

function createIndexStore(): IndexStore {
  const rows: TicketIndexRow[] = [];
  return {
    rows,
    repository: {
      async upsertIssue(input) {
        const existing = rows.find((row) => row.projectId === input.projectId && row.issueNumber === input.issueNumber);
        if (existing !== undefined) return existing;
        const row: TicketIndexRow = {
          id: randomUUID(),
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
          syncedAt: FIXTURE_NOW,
          syncStatus: input.syncStatus ?? "ready",
        };
        rows.push(row);
        return row;
      },
      async listPage() {
        return rows;
      },
      async findByIssueNumber({ projectId, issueNumber }) {
        return rows.find((row) => row.projectId === projectId && row.issueNumber === issueNumber);
      },
      async countByProject(projectId) {
        return rows.filter((row) => row.projectId === projectId).length;
      },
    },
  };
}

interface GitHarness {
  readonly service: GitService;
  readonly calls: string[];
  readonly createIssueInputs: CreateIssueInput[];
  /** 建工单的响应；未声明时给出「未声明」错误而不是编造数据。 */
  setCreateIssue(implementation: (input: CreateIssueInput) => Promise<GitIssue>): void;
}

function createGitHarness(): GitHarness {
  const calls: string[] = [];
  const createIssueInputs: CreateIssueInput[] = [];
  let createIssue: (input: CreateIssueInput) => Promise<GitIssue> = async () => {
    throw new Error("用例未声明 issues.create 的返回值");
  };
  const unused = async (operation: string): Promise<never> => {
    throw new Error(`用例未声明 Git 操作 ${operation}`);
  };
  const scopedClient: GitScopedClient = {
    consumerId: "tickets",
    organizationId: ORG_A,
    repository: {
      connectionId: "primary",
      providerRepositoryId: "repo-alpha",
      owner: "aos-bot",
      name: "aos-tickets-alpha",
    },
    repositories: {
      get: async () => unused("repositories.get"),
      ensureIssuesEnabled: async () => unused("repositories.ensureIssuesEnabled"),
    },
    issues: {
      list: async () => unused("issues.list"),
      get: async () => unused("issues.get"),
      create: async (input) => {
        calls.push("issues.create");
        createIssueInputs.push(input);
        return createIssue(input);
      },
      edit: async () => unused("issues.edit"),
      setLabels: async () => unused("issues.setLabels"),
    },
    comments: {
      list: async () => unused("comments.list"),
      create: async () => unused("comments.create"),
      edit: async () => unused("comments.edit"),
    },
    labels: {
      list: async () => unused("labels.list"),
      create: async () => unused("labels.create"),
      edit: async () => unused("labels.edit"),
    },
  };
  return {
    calls,
    createIssueInputs,
    setCreateIssue(implementation) {
      createIssue = implementation;
    },
    service: {
      connectionIds: ["primary"],
      async createScopedClient(input) {
        calls.push(`createScopedClient:${input.bindingId}`);
        return scopedClient;
      },
      admin: {
        createPrivateRepository: async () => unused("admin.createPrivateRepository"),
        getRepository: async () => unused("admin.getRepository"),
        ensureIssuesEnabled: async () => unused("admin.ensureIssuesEnabled"),
        bindExistingRepository: async () => unused("admin.bindExistingRepository"),
        getBinding: async () => unused("admin.getBinding"),
      },
    },
  };
}

interface Harness {
  readonly service: TicketService;
  readonly git: GitHarness;
  readonly operationStore: OperationStore;
  readonly messageStore: MessageStore;
  readonly indexStore: IndexStore;
}

/** 装配真实的工单领域服务 + 操作账本服务，注入记录型仓储与 Git 替身。 */
function createHarness(): Harness {
  const git = createGitHarness();
  const operationStore = createOperationStore();
  const messageStore = createMessageStore();
  const indexStore = createIndexStore();
  const operations = createTicketOperationService(operationStore.repository);
  return {
    git,
    operationStore,
    messageStore,
    indexStore,
    service: createTicketService({
      messages: messageStore.repository,
      index: indexStore.repository,
      operations,
      git: git.service,
    }),
  };
}

const PROJECT_ROW: TicketProjectRow = {
  id: PROJECT_A,
  organizationId: ORG_A,
  repositoryRef: BINDING_A,
  connectionId: "primary",
  providerRepositoryId: "repo-alpha",
  owner: "aos-bot",
  name: "aos-tickets-alpha",
  isDefault: true,
  status: "active",
  createdBy: "user_admin",
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

/** 只服务创建路径的 Facade 依赖：授权条件固定、可见项目固定、其余端口一旦被调用即失败。 */
function createFacadeWith(harness: Harness): TicketFacadeApi {
  const unused = async (): Promise<never> => {
    throw new Error("本用例不应调用该端口");
  };
  const constraint: ResourceQueryConstraint = {
    resourceType: TICKET_PROJECT_RESOURCE_TYPE,
    action: "read",
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { organizationId: ORG_A },
  };
  const accessControl: AccessControlModule = {
    id: "test-access-control",
    resolveInitialScope: unused,
    initializeResourceAccess: unused,
    authorize: unused,
    createListConstraint: async () => constraint,
    resolveAccess: unused,
    resolveAccessMany: unused,
  };
  const projects: TicketProjectService = {
    listReadable: async () => [PROJECT_ROW],
    findReadable: async () => PROJECT_ROW,
    provision: unused,
    setDefault: unused,
    setStatus: unused,
  };
  const scopeStore: ResourceScopeStore = {
    initialize: unused,
    getMany: unused,
    update: unused,
    remove: unused,
  };
  return createTicketFacade({
    accessControl,
    scopeStore,
    identity: getIdentityDirectory(),
    projects,
    operations: createTicketOperationService(harness.operationStore.repository),
    service: harness.service,
  });
}

const MEMBER: ActorContext = {
  kind: "user",
  userId: "user_member",
  activeOrganizationId: ORG_A,
  memberships: [{ organizationId: ORG_A, role: "member" }],
};

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
});

describe("建工单 — 幂等", () => {
  // 同键同内容的第二次提交复用既有成功操作：返回同一份坐标与同一作者归属，且不再调用 issues.create。
  test("同键同内容重放复用原操作且不重复出站", async () => {
    const harness = createHarness();
    harness.git.setCreateIssue(async (input) => gitIssue({ title: input.title, body: input.body }));

    const first = await harness.service.createIssue(createInput());
    const second = await harness.service.createIssue(createInput());

    if (first.kind !== "created" || second.kind !== "created") {
      throw new Error(`期望两次都创建成功，实际是 ${first.kind} / ${second.kind}`);
    }
    expect(second.operationId).toBe(first.operationId);
    expect(second.facts.issueNumber).toBe(first.facts.issueNumber);
    expect(second.facts.author).toEqual(first.facts.author);
    expect(harness.git.calls.filter((call) => call === "issues.create").length).toBe(1);
    expect(harness.operationStore.rows.length).toBe(1);
    expect(harness.messageStore.rows.length).toBe(1);
  });

  // 同键配不同内容（标题多一个空格）判 409 IDEMPOTENCY_CONFLICT：既有操作不被覆盖，也不产生第二次远端调用。
  test("同键不同内容报 IDEMPOTENCY_CONFLICT 且不覆盖既有操作", async () => {
    const harness = createHarness();
    harness.git.setCreateIssue(async (input) => gitIssue({ title: input.title, body: input.body }));
    const first = await harness.service.createIssue(createInput());
    if (first.kind !== "created") throw new Error(`期望首次创建成功，实际是 ${first.kind}`);

    const failure = await harness.service
      .createIssue(createInput({ title: "预览页打不开 " }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IdempotencyConflictError);
    expect(failure).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect(harness.git.createIssueInputs.length).toBe(1);
    expect(harness.operationStore.rows.length).toBe(1);
    // 既有成功结果原样保留（账本行只有一条，工单坐标没有被后来的请求改写）。
    expect(harness.operationStore.rows[0]?.result).toMatchObject({ issueNumber: first.facts.issueNumber });
  });

  // 幂等键在服务层复检：绕过路由的直接调用方也拿不到非法键（它会写进 varchar(128) 列，超长会从 400 变成 500）。
  test("幂等键格式非法时报 400 且零副作用", async () => {
    const harness = createHarness();

    await expect(harness.service.createIssue(createInput({ idempotencyKey: "short" }))).rejects.toThrow(
      ValidationError,
    );
    expect(harness.operationStore.rows).toEqual([]);
    expect(harness.git.calls).toEqual([]);
  });
});

describe("建工单 — 版本冲突", () => {
  // 内容指纹覆盖标题、正文、状态与排序后的标签集合：任何一处变化都会改变版本，过期版本因此可判别。
  test("内容指纹随内容变化且对标签顺序与换行不敏感", () => {
    const base = { title: "预览页打不开", body: "正文", state: "open" as const, labelNames: ["p1", "bug"] };
    const fingerprint = computeContentVersion(base);

    expect(computeContentVersion({ ...base, labelNames: ["bug", "p1"] })).toBe(fingerprint);
    expect(computeContentVersion({ ...base, body: "正文\r\n" })).toBe(fingerprint);
    expect(computeContentVersion({ ...base, labelNames: ["bug", "p1", "p2"] })).not.toBe(fingerprint);
    expect(computeContentVersion({ ...base, body: "正文改过" })).not.toBe(fingerprint);
    expect(computeContentVersion({ ...base, state: "closed" })).not.toBe(fingerprint);
  });

  // VERSION_CONFLICT 的状态码与错误码映射（路由按 statusCode 落在已声明集合内映射信封）；判定点归 T03。
  test("VersionConflictError 映射为 409 VERSION_CONFLICT 信封", () => {
    // 记录路由写出的状态与信封：`TicketStatusWriter` 是泛型签名，正文按 `unknown` 收下再逐字段断言。
    let written: { readonly status: number; readonly body: unknown } | undefined;
    const writer: TicketStatusWriter = (code, body) => {
      written = { status: code, body };
      return body;
    };

    const envelope = mapTicketError(new VersionConflictError(), writer);

    expect(written?.status).toBe(409);
    expect(envelope).toMatchObject({ success: false, error: { code: "VERSION_CONFLICT" } });
  });
});

describe("建工单 — 202 未定结果的产生条件", () => {
  // 上游写结果未定（WRITE_UNCERTAIN）：操作落 uncertain 并保留 intent 原文，调用方据 202 复核而不是重发。
  test("上游 WRITE_UNCERTAIN 落 uncertain 并保留 intent 原文", async () => {
    const harness = createHarness();
    let ledgerStatusAtCall: string | undefined;
    harness.git.setCreateIssue(async () => {
      ledgerStatusAtCall = harness.operationStore.rows[0]?.status;
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    });

    const outcome = await harness.service.createIssue(createInput());

    expect(outcome.kind).toBe("uncertain");
    // 「先声明幂等再出站」：请求发出时账本行已存在且已被本次执行者领取。
    expect(ledgerStatusAtCall).toBe("dispatching");
    expect(harness.operationStore.rows[0]).toMatchObject({
      status: "uncertain",
      step: "dispatching",
      intent: { title: "预览页打不开", body: "正文" },
    });
    expect(harness.messageStore.rows).toEqual([]);
  });

  // 本地终态写入失败（唯一索引冲突等）时保持 dispatching 并上抛：同键重试只返回未定，绝不二次创建。
  test("本地终态写入失败后同键重试返回未定且不再出站", async () => {
    const harness = createHarness();
    harness.git.setCreateIssue(async (input) => gitIssue({ title: input.title, body: input.body }));
    harness.messageStore.failInsertWith(new Error("ticket_messages 唯一索引冲突：message_id 已存在"));

    await expect(harness.service.createIssue(createInput())).rejects.toThrow("唯一索引冲突");
    // 归属与索引行都不落库，操作保持 dispatching（远端对象已存在，恢复核对归 T03）。
    expect(harness.messageStore.rows).toEqual([]);
    expect(harness.indexStore.rows).toEqual([]);
    expect(harness.operationStore.rows[0]).toMatchObject({ status: "dispatching" });

    harness.messageStore.failInsertWith(null);
    const retry = await harness.service.createIssue(createInput());

    expect(retry.kind).toBe("uncertain");
    expect(harness.git.createIssueInputs.length).toBe(1);
  });

  // 同键既有 dispatching 行（另一执行者正在途）：直接返回未定，绝不重发请求制造第二次远端写入。
  test("同键已领取时返回未定且零上游调用", async () => {
    const harness = createHarness();
    harness.operationStore.rows.push({
      id: randomUUID(),
      organizationId: ORG_A,
      projectId: PROJECT_A,
      actorId: "user_member",
      kind: "issue.create",
      targetId: null,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestHash: hashTicketRequest({
        kind: "issue.create",
        targetPath: issueCreateTargetPath(PROJECT_A),
        payload: { title: "预览页打不开", body: "正文" },
      }),
      messageId: "msg_existing",
      expectedVersion: null,
      intent: { title: "预览页打不开", body: "正文" },
      step: "dispatching",
      status: "dispatching",
      result: null,
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    });

    const outcome = await harness.service.createIssue(createInput());

    expect(outcome).toEqual({ kind: "uncertain", operationId: harness.operationStore.rows[0]?.id });
    expect(harness.git.calls).toEqual([]);
  });

  // 服务层的未定结论由 Facade 原样透传：路由据此回 202 + `{operationId, status:"uncertain"}`，不组装任何工单视图。
  test("Facade 把未定结果原样透传给路由", async () => {
    const harness = createHarness();
    harness.git.setCreateIssue(async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    });

    const outcome = await createFacadeWith(harness).create(
      MEMBER,
      PROJECT_A,
      { title: "预览页打不开", body: "正文" },
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toEqual({ kind: "uncertain", operationId: harness.operationStore.rows[0]?.id });
  });
});

describe("建工单 — 上游确定失败的收敛", () => {
  // 上游 NOT_FOUND 是确定失败：写 failed 终态（只留状态码、错误码与文案）并报 404，同键重放不再触网。
  test("上游 NOT_FOUND 落 failed 并报 404，重放还原同一错误", async () => {
    const harness = createHarness();
    harness.git.setCreateIssue(async () => {
      throw new GitError("NOT_FOUND", "仓库不存在");
    });

    const failure = await harness.service.createIssue(createInput()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect(failure).toMatchObject({ statusCode: 404 });
    const operation = harness.operationStore.rows[0];
    expect(operation).toMatchObject({
      status: "failed",
      step: "upstream_failed",
      result: { statusCode: 404, code: "NOT_FOUND" },
    });
    // 账本只持久化对外会重新用到的三要素：请求正文与上游报文都不进结果。
    expect(Object.keys(operation?.result ?? {}).sort()).toEqual(["code", "message", "statusCode"]);

    const callsAfterFirst = harness.git.calls.length;
    await expect(harness.service.createIssue(createInput())).rejects.toThrow(NotFoundError);
    expect(harness.git.calls.length).toBe(callsAfterFirst);
  });

  // 上游 CONFLICT 同样是确定失败：落 failed 并报 409，不重试（重试外部写被合同明确禁止）。
  test("上游 CONFLICT 落 failed 并报 409", async () => {
    const harness = createHarness();
    harness.git.setCreateIssue(async () => {
      throw new GitError("CONFLICT", "仓库已存在同名工单");
    });

    const failure = await harness.service.createIssue(createInput()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure).toMatchObject({ statusCode: 409 });
    // 账本错误码沿用平台 ConflictError 的历史值 ALREADY_EXISTS，而不是上游的 CONFLICT——还原表按前者索引。
    expect(harness.operationStore.rows[0]).toMatchObject({
      status: "failed",
      result: { statusCode: 409, code: "ALREADY_EXISTS" },
    });
    expect(harness.git.createIssueInputs.length).toBe(1);
  });
});
