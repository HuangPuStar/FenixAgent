import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type AuthorizedResourceQuery,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceQueryConstraint,
} from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { ticketProjects } from "@fenix/resource-tickets/db";
import { getTableName, type SQL, type SQLWrapper } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { TICKET_PROJECT_RESOURCE_TYPE } from "../server/access/ticket-project-resource";
import { createTicketIndexRepository, type TicketIndexRow } from "../server/repositories/ticket-index";
import { createTicketMessageRepository, type TicketMessageRow } from "../server/repositories/ticket-messages";
import { createTicketOperationRepository, type TicketOperationRow } from "../server/repositories/ticket-operations";
import {
  createTicketProjectRepository,
  type ScopedTicketProjectRow,
  type TicketProjectQueryStorage,
  type TicketProjectRow,
} from "../server/repositories/ticket-projects";

/**
 * 仓储层的**存储侧契约**：授权条件如何到达 SQL、幂等账本写了哪些列、索引查询用什么谓词。
 *
 * 测试进程里没有 Postgres，因此本文件覆盖两类事实：
 * 1. **发出的语句**——用记录型 DB 替身（`stubDb` + `initializeTestApplicationInfrastructure` 是仓库既有
 *    注入路径）断言列值、冲突目标、WHERE 列名与排序谓词，不执行 SQL；
 * 2. **只存在于 DDL 里的约束**——部分唯一索引与外键直接从 schema 声明断言（先例：
 *    `plugin-catalog-store.test.ts` 对目录约束的做法）。
 *
 * 授权谓词本身的语义（动作推导与 SQL 等价）在 `packages/platform/access-control` 的用例里验证；这里只
 * 断言资源包这一侧：条件必须原样下推、计数与列表必须共用同一份条件、仓储不得在内存里过滤可见集合。
 */

const dialect = new PgDialect();
const FIXTURE_NOW = new Date("2026-10-12T00:00:00.000Z");

type Row = Record<string, unknown>;

interface RecordedSelect {
  readonly kind: "select";
  readonly table: string;
  where?: unknown;
  orderBy?: readonly unknown[];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

interface RecordedInsert {
  readonly kind: "insert";
  readonly table: string;
  values?: Row;
  conflict?: { readonly kind: "doNothing" | "doUpdate"; readonly target?: unknown; readonly set?: Row };
}

interface RecordedUpdate {
  readonly kind: "update";
  readonly table: string;
  values?: Row;
  where?: unknown;
}

type RecordedCall =
  | RecordedSelect
  | RecordedInsert
  | RecordedUpdate
  | { readonly kind: "execute"; readonly sql: string }
  | { readonly kind: "transaction" };

/**
 * 链式替身：生产代码的链式调用顺序任意，因此每个方法都返回自身，末端的 `returning`/`await` 给出预制行。
 */
interface Chainable {
  where(condition: unknown): Chainable;
  orderBy(...order: readonly unknown[]): Chainable;
  limit(value: number): Chainable;
  offset(value: number): Chainable;
  for(mode: string): Chainable;
  values(values: Row): Chainable;
  onConflictDoNothing(config?: { target?: unknown }): Chainable;
  onConflictDoUpdate(config: { target?: unknown; set?: Row }): Chainable;
  returning(): Promise<readonly Row[]>;
  then<TResult1 = readonly Row[], TResult2 = never>(
    onfulfilled?: ((value: readonly Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

/** 记录调用并可被 await 的链式替身；记录字段随调用点赋值，故对象本身在 `calls` 里保持可见。 */
function createChainable(call: RecordedCall, rows: () => readonly Row[]): Chainable {
  const builder: Chainable = {
    where: (condition) => {
      if (call.kind === "select" || call.kind === "update") call.where = condition;
      return builder;
    },
    orderBy: (...order) => {
      if (call.kind === "select") call.orderBy = order;
      return builder;
    },
    limit: (value) => {
      if (call.kind === "select") call.limit = value;
      return builder;
    },
    offset: (value) => {
      if (call.kind === "select") call.offset = value;
      return builder;
    },
    for: (mode) => {
      if (call.kind === "select") call.forUpdate = mode === "update";
      return builder;
    },
    values: (values) => {
      if (call.kind === "insert") call.values = values;
      return builder;
    },
    onConflictDoNothing: (config) => {
      if (call.kind === "insert") call.conflict = { kind: "doNothing", target: config?.target };
      return builder;
    },
    onConflictDoUpdate: (config) => {
      if (call.kind === "insert") call.conflict = { kind: "doUpdate", target: config.target, set: config.set };
      return builder;
    },
    returning: async () => rows(),
    // biome-ignore lint/suspicious/noThenProperty: 生产代码把链式对象直接 await，替身必须真的可 await。
    then: (onfulfilled, onrejected) => Promise.resolve(rows()).then(onfulfilled, onrejected),
  };
  return builder;
}

type RecordingDatabase = {
  readonly calls: RecordedCall[];
  transaction<T>(run: (handle: RecordingDatabase) => Promise<T>): Promise<T>;
  execute(statement: SQL): Promise<readonly Row[]>;
  select(columns?: unknown): { from(table: unknown): Chainable };
  insert(table: unknown): { values(values: Row): Chainable };
  update(table: unknown): { set(values: Row): Chainable };
};

/** 记录型 DB 替身：只回答「调用方按什么顺序、对哪张表、写了哪些列」，不执行任何 SQL。 */
function createRecordingDatabase(
  options: {
    readonly selectRows?: Record<string, readonly Row[]>;
    readonly insertRows?: readonly Row[];
    readonly updateRows?: readonly Row[];
  } = {},
): RecordingDatabase {
  const calls: RecordedCall[] = [];
  const selectRows = options.selectRows ?? {};
  const insertRows = options.insertRows ?? [];
  const updateRows = options.updateRows ?? [];

  const handle: RecordingDatabase = {
    calls,
    execute: async (statement) => {
      calls.push({ kind: "execute", sql: dialect.sqlToQuery(statement).sql });
      return [];
    },
    select: () => ({
      from: (table) => {
        const call: RecordedSelect = { kind: "select", table: getTableName(table as never) };
        calls.push(call);
        return createChainable(call, () => selectRows[call.table] ?? []);
      },
    }),
    insert: (table) => ({
      values: (values) => {
        const call: RecordedInsert = { kind: "insert", table: getTableName(table as never), values };
        calls.push(call);
        return createChainable(call, () => insertRows);
      },
    }),
    update: (table) => ({
      set: (values) => {
        const call: RecordedUpdate = { kind: "update", table: getTableName(table as never), values };
        calls.push(call);
        return createChainable(call, () => updateRows);
      },
    }),
    transaction: async (run) => {
      calls.push({ kind: "transaction" });
      return run(handle);
    },
  };
  return handle;
}

/** 用给定行集合装配替身 DB；未给到的表视为空表。必须先复位：替身与基础设施都是进程级状态。 */
function useDatabase(options: Parameters<typeof createRecordingDatabase>[0] = {}): RecordingDatabase {
  resetAllStubs();
  const database = createRecordingDatabase(options);
  stubDb(database);
  initializeTestApplicationInfrastructure();
  return database;
}

const insertsOf = (calls: readonly RecordedCall[]): RecordedInsert[] =>
  calls.filter((call): call is RecordedInsert => call.kind === "insert");
const updatesOf = (calls: readonly RecordedCall[]): RecordedUpdate[] =>
  calls.filter((call): call is RecordedUpdate => call.kind === "update");
const selectsOf = (calls: readonly RecordedCall[]): RecordedSelect[] =>
  calls.filter((call): call is RecordedSelect => call.kind === "select");

/** 取出 Drizzle 片段的 `SQL` 对象；列对象与条件对象都实现了 `SQLWrapper`。 */
function sqlOf(value: unknown): SQL | undefined {
  if (value === null || typeof value !== "object") return;
  const wrapper = value as Partial<SQLWrapper>;
  return typeof wrapper.getSQL === "function" ? wrapper.getSQL() : undefined;
}

/** 渲染一段 Drizzle SQL 片段，供断言谓词文本。 */
function renderSql(value: unknown): string {
  const statement = sqlOf(value);
  return statement === undefined ? "" : dialect.sqlToQuery(statement).sql;
}

/** 渲染并取出参数；用于断言模糊匹配的转义与游标取值。 */
function paramsOf(value: unknown): readonly unknown[] {
  const statement = sqlOf(value);
  return statement === undefined ? [] : dialect.sqlToQuery(statement).params;
}

/** 从 SQL chunk 树收集列名；不能 `JSON.stringify`（表与列互相引用会抛循环结构错误）。 */
function collectColumnNames(node: unknown, names: string[] = []): string[] {
  if (node === null || typeof node !== "object") return names;
  const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) collectColumnNames(chunk, names);
    return names;
  }
  const candidate = node as { name?: unknown; dataType?: unknown; columnType?: unknown };
  if (typeof candidate.name === "string" && candidate.dataType !== undefined && candidate.columnType !== undefined) {
    names.push(candidate.name);
  }
  return names;
}

const whereColumns = (call: { readonly where?: unknown }): string[] => collectColumnNames(call.where);

const FIXTURE_PROJECT: TicketProjectRow = {
  id: "project-1",
  organizationId: "org-1",
  repositoryRef: "binding-1",
  connectionId: "connection-1",
  providerRepositoryId: "42",
  owner: "aos",
  name: "aos-tickets-org1",
  isDefault: true,
  status: "active",
  createdBy: "user-1",
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

const FIXTURE_OPERATION: TicketOperationRow = {
  id: "operation-1",
  organizationId: "org-1",
  projectId: "project-1",
  actorId: "user-1",
  kind: "issue.create",
  targetId: null,
  idempotencyKey: "key-1",
  requestHash: "hash-1",
  messageId: "msg-1",
  expectedVersion: null,
  intent: { title: "标题", body: "正文" },
  step: null,
  status: "pending",
  result: null,
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

const FIXTURE_MESSAGE: TicketMessageRow = {
  id: "message-row-1",
  projectId: "project-1",
  objectKind: "issue",
  providerObjectId: "7",
  messageId: "msg-1",
  authorId: "user-1",
  authorNameSnapshot: "张三",
  bodyHash: "body-hash-1",
  revision: 1,
  lastEditorId: null,
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

const FIXTURE_INDEX_ROW: TicketIndexRow = {
  id: "index-1",
  projectId: "project-1",
  issueNumber: "7",
  title: "标题",
  state: "open",
  authorId: "user-1",
  authorName: "张三",
  assigneeId: null,
  labelIds: [],
  contentVersion: "version-1",
  providerUpdatedAt: FIXTURE_NOW,
  syncedAt: FIXTURE_NOW,
  syncStatus: "ready",
};

/** 构造平台授权条件句柄；形状与 `DefaultAccessControl` 产出的条件一致（含私有载荷键）。 */
function testListConstraint(action: "read" | "use" = "read"): ResourceQueryConstraint {
  return {
    resourceType: TICKET_PROJECT_RESOURCE_TYPE,
    action,
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action },
  };
}

/** 记录调用的授权查询端口替身；返回行由用例给定。 */
function createRecordingQuery(rows: readonly ScopedTicketProjectRow[] = []) {
  const listInputs: unknown[] = [];
  const countInputs: unknown[] = [];
  const findInputs: unknown[] = [];
  const query: AuthorizedResourceQuery<TicketProjectQueryStorage> = {
    list: async (input) => {
      listInputs.push(input);
      return { items: [...rows] };
    },
    count: async (input) => {
      countInputs.push(input);
      return rows.length;
    },
    findById: async (input) => {
      findInputs.push(input);
      return rows[0];
    },
  };
  return { query, listInputs, countInputs, findInputs };
}

const scopedProject = (organizationId = "org-1", id = "project-1"): ScopedTicketProjectRow => ({
  ...FIXTURE_PROJECT,
  id,
  organizationId,
  scope: { organizationId, visibility: "private" },
});

beforeEach(() => {
  resetAllStubs();
});

// 本文件登记过进程级 DB 替身与应用基础设施：收尾复位，避免替身泄漏到同进程的其它测试文件。
afterAll(() => {
  resetAllStubs();
});

describe("ticket_projects 仓储", () => {
  // 受控读取必须把注册表的资源类型、归属列与不透明授权条件一起交给端口：仓储不解释、不重写条件。
  test("listReadable 交出资源类型、归属列与授权条件", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createTicketProjectRepository(query);
    const constraint = testListConstraint();

    await repository.listReadable({ access: constraint, limit: 10, offset: 20 });

    const input = listInputs[0] as {
      resourceType?: string;
      columns?: { organizationId?: unknown };
      access?: unknown;
      limit?: number;
      offset?: number;
    };
    expect(input.resourceType).toBe(TICKET_PROJECT_RESOURCE_TYPE);
    // 归属列必须交给平台：授权谓词（同组织可见）就是靠它编译出来的，漏传等于没有组织边界。
    expect(input.columns?.organizationId).toBeDefined();
    expect(input.access).toBe(constraint);
    expect(input.limit).toBe(10);
    expect(input.offset).toBe(20);
  });

  // 计数与列表必须共用同一份授权条件；计数还不能带分页，它算的是整个可见集合的基数。
  test("listReadable 的计数与列表共用条件且不带分页", async () => {
    const { query, listInputs, countInputs } = createRecordingQuery();
    const repository = createTicketProjectRepository(query);
    const constraint = testListConstraint();

    await repository.listReadable({ access: constraint, limit: 10, offset: 20 });

    const countInput = countInputs[0] as { access?: unknown; limit?: number; offset?: number };
    expect(countInput.access).toBe(constraint);
    expect(countInput.limit).toBeUndefined();
    expect(countInput.offset).toBeUndefined();
    expect((listInputs[0] as { businessOrder?: unknown }).businessOrder).toBeDefined();
  });

  // 端口返回什么就返回什么：可见性完全由 SQL 决定，仓储不得在内存里二次过滤跨组织行。
  test("listReadable 原样返回端口结果，不在内存中过滤", async () => {
    const { query } = createRecordingQuery([scopedProject("org-1", "project-1"), scopedProject("org-2", "project-2")]);
    const repository = createTicketProjectRepository(query);

    const page = await repository.listReadable({ access: testListConstraint() });

    expect(page.items.map((row) => row.id)).toEqual(["project-1", "project-2"]);
    expect(page.total).toBe(2);
  });

  // 详情入口只交出资源 ID 与授权条件：自行补组织条件会把「跨组织不可见」的判定复制到仓储。
  test("findReadableById 只交出资源 ID 与授权条件", async () => {
    const { query, findInputs } = createRecordingQuery([scopedProject()]);
    const repository = createTicketProjectRepository(query);
    const constraint = testListConstraint();

    const row = await repository.findReadableById({ access: constraint, projectId: "project-1" });

    expect(row?.id).toBe("project-1");
    const input = findInputs[0] as { access?: unknown; resourceId?: string; businessWhere?: unknown };
    expect(input.access).toBe(constraint);
    expect(input.resourceId).toBe("project-1");
    expect(input.businessWhere).toBeUndefined();
  });

  // 重复开通同一绑定只刷新坐标快照：归属列、创建者、默认标记与暂停状态都不许被这次写入改掉。
  test("upsertByBinding 冲突时只刷新坐标快照", async () => {
    const database = useDatabase({ insertRows: [FIXTURE_PROJECT] });
    const repository = createTicketProjectRepository(createRecordingQuery().query);

    await repository.upsertByBinding({
      organizationId: "org-1",
      bindingId: "binding-1",
      connectionId: "connection-1",
      providerRepositoryId: "42",
      owner: "aos",
      name: "aos-tickets-org1",
      createdBy: "user-1",
    });

    const insert = insertsOf(database.calls)[0];
    expect(insert?.values?.organizationId).toBe("org-1");
    expect(insert?.values?.repositoryRef).toBe("binding-1");
    expect(insert?.values?.createdBy).toBe("user-1");
    expect(insert?.conflict?.kind).toBe("doUpdate");
    expect(Object.keys(insert?.conflict?.set ?? {}).sort()).toEqual([
      "connectionId",
      "name",
      "owner",
      "providerRepositoryId",
      "updatedAt",
    ]);
  });

  // 默认切换必须在一个事务里先清旧默认再置新默认：反过来会先撞「每组织一条 active default」的部分唯一索引。
  test("setDefault 在同一事务内先清后置", async () => {
    const database = useDatabase();
    const repository = createTicketProjectRepository(createRecordingQuery().query);

    await repository.setDefault({ organizationId: "org-1", projectId: "project-2" });

    expect(database.calls.map((call) => call.kind)).toEqual(["transaction", "execute", "update", "update"]);
    const [clear, mark] = updatesOf(database.calls);
    expect(clear?.values?.isDefault).toBe(false);
    expect(mark?.values?.isDefault).toBe(true);
    expect(whereColumns(clear ?? {})).toEqual(expect.arrayContaining(["organization_id", "is_default"]));
    // 两条 UPDATE 都必须限定在本组织：漏掉组织条件会改到别的组织的默认标记。
    expect(whereColumns(clear ?? {})).toContain("organization_id");
    expect(whereColumns(mark ?? {})).toContain("organization_id");
  });

  // 启停是组织内的目标写入：命中返回 true，未命中（跨组织或已不存在）返回 false，由调用方映射 404。
  test("setStatus 以是否命中行作为结果", async () => {
    const database = useDatabase({ updateRows: [{ id: "project-1" }] });
    const repository = createTicketProjectRepository(createRecordingQuery().query);

    expect(await repository.setStatus({ organizationId: "org-1", projectId: "project-1", status: "paused" })).toBe(
      true,
    );
    const update = updatesOf(database.calls)[0];
    expect(update?.values?.status).toBe("paused");
    expect(whereColumns(update ?? {})).toEqual(expect.arrayContaining(["id", "organization_id"]));

    useDatabase({ updateRows: [] });
    const emptyRepository = createTicketProjectRepository(createRecordingQuery().query);
    expect(await emptyRepository.setStatus({ organizationId: "org-1", projectId: "project-9", status: "active" })).toBe(
      false,
    );
  });

  // 部分唯一索引只约束 active 且 is_default 的行：这是「暂停组织工单 = 默认项目置 paused」能成立的前提。
  test("默认项目唯一索引只覆盖 active 行", () => {
    const index = getTableConfig(ticketProjects).indexes.find(
      (item) => item.config.name === "ticket_projects_default_active_uq",
    );
    expect(index?.config.unique).toBe(true);
    const predicate = renderSql(index?.config.where);
    expect(predicate).toContain("is_default");
    expect(predicate).toContain("status");
    expect(predicate).toContain("active");
  });

  // 跨包外键只有一处：仓库绑定删除必须被数据库挡住（restrict），不能留下悬空项目（决策 D3）。
  test("repository_ref 外键指向 git_repository_bindings 且为 restrict", () => {
    const [foreignKey] = getTableConfig(ticketProjects).foreignKeys;
    const reference = foreignKey?.reference();
    expect(reference === undefined ? "" : getTableName(reference.foreignTable)).toBe("git_repository_bindings");
    expect(foreignKey?.onDelete).toBe("restrict");
  });
});

describe("ticket_operations 仓储", () => {
  // 首次声明插入 pending 行并声明 (组织, actor, 幂等键) 冲突目标：status 走列默认，不在这里硬编码。
  test("claim 首次插入返回 created 并声明唯一冲突目标", async () => {
    const database = useDatabase({ insertRows: [FIXTURE_OPERATION] });
    const repository = createTicketOperationRepository();

    const result = await repository.claim({
      organizationId: "org-1",
      actorId: "user-1",
      kind: "issue.create",
      projectId: "project-1",
      idempotencyKey: "key-1",
      requestHash: "hash-1",
      messageId: "msg-1",
      expectedVersion: null,
      intent: { title: "标题", body: "正文" },
    });

    expect(result.outcome).toBe("created");
    expect(result.row.id).toBe("operation-1");
    const insert = insertsOf(database.calls)[0];
    expect(insert?.values?.idempotencyKey).toBe("key-1");
    expect(insert?.values?.messageId).toBe("msg-1");
    // 状态由列默认给出：本层不写死 'pending'，迁移改默认值时不会出现两处真相。
    expect(insert?.values?.status).toBeUndefined();
    expect(insert?.conflict?.kind).toBe("doNothing");
    const target = insert?.conflict?.target;
    expect(Array.isArray(target) ? target.map((column) => (column as { name?: string }).name) : []).toEqual([
      "organization_id",
      "actor_id",
      "idempotency_key",
    ]);
  });

  // 冲突时读回既有行（绝不覆盖），并且要 FOR UPDATE：同键并发靠这把行锁在事务内排队裁决。
  test("claim 冲突时读回既有行并加行锁", async () => {
    const database = useDatabase({
      insertRows: [],
      selectRows: { ticket_operations: [{ ...FIXTURE_OPERATION, status: "succeeded" }] },
    });
    const repository = createTicketOperationRepository();

    const result = await repository.claim({
      organizationId: "org-1",
      actorId: "user-1",
      kind: "issue.create",
      projectId: "project-1",
      idempotencyKey: "key-1",
      requestHash: "hash-1",
      messageId: "msg-1",
      expectedVersion: null,
      intent: { title: "标题", body: "正文" },
    });

    expect(result.outcome).toBe("existing");
    expect(result.row.status).toBe("succeeded");
    const select = selectsOf(database.calls)[0];
    expect(select?.forUpdate).toBe(true);
    expect(whereColumns(select ?? {})).toEqual(
      expect.arrayContaining(["organization_id", "actor_id", "idempotency_key"]),
    );
  });

  // 领取是「只有 pending → dispatching」的条件更新：另一执行者已领取时返回 false，调用方据此返回 202。
  test("markDispatching 只对 pending 生效", async () => {
    const database = useDatabase({ updateRows: [{ id: "operation-1" }] });
    const repository = createTicketOperationRepository();

    expect(await repository.markDispatching({ operationId: "operation-1", step: "creating_issue" })).toBe(true);
    const update = updatesOf(database.calls)[0];
    expect(update?.values?.status).toBe("dispatching");
    expect(update?.values?.step).toBe("creating_issue");
    expect(whereColumns(update ?? {})).toEqual(expect.arrayContaining(["id", "status"]));

    useDatabase({ updateRows: [] });
    const busyRepository = createTicketOperationRepository();
    expect(await busyRepository.markDispatching({ operationId: "operation-1", step: "creating_issue" })).toBe(false);
  });

  // 成功终态把 intent 改写成摘要：待发送正文在成功那一刻就必须从库里消失。
  test("markSucceeded 用摘要覆盖 intent", async () => {
    const database = useDatabase();
    const repository = createTicketOperationRepository();

    await repository.markSucceeded({
      operationId: "operation-1",
      step: "index_written",
      targetId: "7",
      result: { issueNumber: "7", messageId: "msg-1" },
      intentSummary: { titleLength: 2, bodyHash: "body-hash-1" },
    });

    const update = updatesOf(database.calls)[0];
    expect(update?.values?.status).toBe("succeeded");
    expect(update?.values?.targetId).toBe("7");
    expect(update?.values?.intent).toEqual({ titleLength: 2, bodyHash: "body-hash-1" });
  });

  // 明确失败也要立刻清掉明文 intent（签名不带摘要，故按库内 intent 派生只含标题长度的摘要）。
  test("markFailed 立即清掉明文 intent", async () => {
    const database = useDatabase();
    const repository = createTicketOperationRepository();

    await repository.markFailed({ operationId: "operation-1", step: "creating_issue", result: { code: "CONFLICT" } });

    const update = updatesOf(database.calls)[0];
    expect(update?.values?.status).toBe("failed");
    expect(update?.values?.result).toEqual({ code: "CONFLICT" });
    const intent = update?.values?.intent;
    expect(intent).not.toEqual({ title: "标题", body: "正文" });
    expect(renderSql(intent)).toContain("titleLength");
    expect(renderSql(intent)).not.toContain("body");
  });

  // 结果未定时保留 intent 原文：T03 要按 message_id 回源核对，核对需要当时的请求内容。
  test("markUncertain 保留 intent 供回源核对", async () => {
    const database = useDatabase();
    const repository = createTicketOperationRepository();

    await repository.markUncertain({ operationId: "operation-1", step: "creating_issue" });

    const update = updatesOf(database.calls)[0];
    expect(update?.values?.status).toBe("uncertain");
    expect(update?.values).not.toHaveProperty("intent");
    expect(update?.values).not.toHaveProperty("result");
  });

  // 操作查询只认「本人的操作」：组织、actor 与操作 ID 三个条件缺一，别的成员或别的组织就能读到账本。
  test("findForActor 把组织与 actor 一起放进 WHERE", async () => {
    const database = useDatabase({ selectRows: { ticket_operations: [FIXTURE_OPERATION] } });
    const repository = createTicketOperationRepository();

    const row = await repository.findForActor({
      organizationId: "org-1",
      actorId: "user-1",
      operationId: "operation-1",
    });

    expect(row?.id).toBe("operation-1");
    expect(whereColumns(selectsOf(database.calls)[0] ?? {})).toEqual(
      expect.arrayContaining(["organization_id", "actor_id", "id"]),
    );

    useDatabase({ selectRows: { ticket_operations: [] } });
    const emptyRepository = createTicketOperationRepository();
    expect(
      await emptyRepository.findForActor({ organizationId: "org-2", actorId: "user-1", operationId: "operation-1" }),
    ).toBeUndefined();
  });

  // 恢复入口按身份头里的 message_id 定位操作（T03 的接口冻结项，T02 先落地）。
  test("findByMessageId 按消息 ID 定位操作", async () => {
    const database = useDatabase({ selectRows: { ticket_operations: [FIXTURE_OPERATION] } });
    const repository = createTicketOperationRepository();

    const row = await repository.findByMessageId("msg-1");

    expect(row?.messageId).toBe("msg-1");
    expect(whereColumns(selectsOf(database.calls)[0] ?? {})).toContain("message_id");
  });
});

describe("ticket_messages 仓储", () => {
  // 新建归属记录写全关联列：作者快照与正文摘要都是后续核验可信性的依据，不能在写入时省略。
  test("insert 写全归属列并给新记录默认值", async () => {
    const database = useDatabase({ insertRows: [FIXTURE_MESSAGE] });
    const repository = createTicketMessageRepository();

    await repository.insert({
      projectId: "project-1",
      objectKind: "issue",
      providerObjectId: "7",
      messageId: "msg-1",
      authorId: "user-1",
      authorNameSnapshot: "张三",
      bodyHash: "body-hash-1",
    });

    const insert = insertsOf(database.calls)[0];
    expect(insert?.values?.authorId).toBe("user-1");
    expect(insert?.values?.authorNameSnapshot).toBe("张三");
    expect(insert?.values?.revision).toBe(1);
    expect(insert?.values?.lastEditorId).toBeNull();
  });

  // 冲突必须抛出而不是改写：静默改写已有归属等于伪造作者，唯一索引是这条防线的最后一段。
  test("insert 不做 ON CONFLICT", async () => {
    const database = useDatabase({ insertRows: [FIXTURE_MESSAGE] });
    const repository = createTicketMessageRepository();

    await repository.insert({
      projectId: "project-1",
      objectKind: "issue",
      providerObjectId: "7",
      messageId: "msg-1",
      authorId: "user-1",
      authorNameSnapshot: "张三",
      bodyHash: "body-hash-1",
    });

    expect(insertsOf(database.calls)[0]?.conflict).toBeUndefined();
  });

  // 按 (项目, 对象类型, 远端对象 ID) 定位：这三列就是唯一索引，命中至多一行。
  test("findObjectMessage 按对象三列定位", async () => {
    const database = useDatabase({ selectRows: { ticket_messages: [FIXTURE_MESSAGE] } });
    const repository = createTicketMessageRepository();

    const row = await repository.findObjectMessage({
      projectId: "project-1",
      objectKind: "issue",
      providerObjectId: "7",
    });

    expect(row?.messageId).toBe("msg-1");
    expect(whereColumns(selectsOf(database.calls)[0] ?? {})).toEqual(
      expect.arrayContaining(["project_id", "object_kind", "provider_object_id"]),
    );
  });

  // 批量核验：空集合短路为零查询，非空时按项目 + 消息 ID 集合过滤（项目条件不能省，否则跨项目取到同 ID 的行）。
  test("findManyByMessageIds 空集合短路，非空按项目过滤", async () => {
    const database = useDatabase({ selectRows: { ticket_messages: [FIXTURE_MESSAGE] } });
    const repository = createTicketMessageRepository();

    expect(await repository.findManyByMessageIds({ projectId: "project-1", messageIds: [] })).toEqual([]);
    expect(database.calls).toEqual([]);

    const rows = await repository.findManyByMessageIds({ projectId: "project-1", messageIds: ["msg-1", "msg-2"] });

    expect(rows.map((row) => row.id)).toEqual(["message-row-1"]);
    expect(whereColumns(selectsOf(database.calls)[0] ?? {})).toEqual(
      expect.arrayContaining(["project_id", "message_id"]),
    );
  });
});

describe("ticket_index 仓储", () => {
  // 冲突目标是 (项目, 工单号)：重复同步是刷新内容列并推进行级同步状态，而不是新增行。
  test("upsertIssue 刷新内容列与同步状态", async () => {
    const database = useDatabase({ insertRows: [FIXTURE_INDEX_ROW] });
    const repository = createTicketIndexRepository();

    await repository.upsertIssue({
      projectId: "project-1",
      issueNumber: "7",
      title: "标题",
      state: "open",
      authorId: "user-1",
      authorName: "张三",
      assigneeId: null,
      labelIds: ["bug"],
      contentVersion: "version-1",
      providerUpdatedAt: FIXTURE_NOW,
    });

    const insert = insertsOf(database.calls)[0];
    expect(insert?.values?.syncStatus).toBe("ready");
    expect(insert?.values?.syncedAt).toBeInstanceOf(Date);
    expect(insert?.values?.labelIds).toEqual(["bug"]);
    expect(insert?.conflict?.kind).toBe("doUpdate");
    const target = insert?.conflict?.target;
    expect(Array.isArray(target) ? target.map((column) => (column as { name?: string }).name) : []).toEqual([
      "project_id",
      "issue_number",
    ]);
    // 定位列不回写：它们就是冲突目标，写回只会制造一次无意义的行更新。
    expect(insert?.conflict?.set).not.toHaveProperty("issueNumber");
    expect(insert?.conflict?.set).not.toHaveProperty("projectId");
  });

  // 列表按工单号数值降序（`10` 必须排在 `9` 前面，字典序做不到）并应用调用方给的 limit。
  test("listPage 按工单号数值降序并应用 limit", async () => {
    const database = useDatabase({ selectRows: { ticket_index: [FIXTURE_INDEX_ROW] } });
    const repository = createTicketIndexRepository();

    const rows = await repository.listPage({ projectId: "project-1", limit: 30 });

    expect(rows.map((row) => row.issueNumber)).toEqual(["7"]);
    const select = selectsOf(database.calls)[0];
    expect(select?.limit).toBe(30);
    expect(renderSql(select?.orderBy?.[0]).toLowerCase()).toContain("desc");
    expect(renderSql(select?.orderBy?.[0])).toContain("::bigint");
    expect(whereColumns(select ?? {})).toEqual(["project_id"]);
  });

  // 状态三态里的 `all` 与缺省都不过滤；游标是排他上界（`issue_number < cursor`），翻页不重复上一页末条。
  test("listPage 只在具体状态上过滤，游标是排他上界", async () => {
    const allDatabase = useDatabase();
    const allRepository = createTicketIndexRepository();
    await allRepository.listPage({ projectId: "project-1", limit: 30, state: "all" });
    expect(whereColumns(selectsOf(allDatabase.calls)[0] ?? {})).toEqual(["project_id"]);

    const openDatabase = useDatabase();
    const openRepository = createTicketIndexRepository();
    await openRepository.listPage({ projectId: "project-1", limit: 30, state: "open", cursor: "9" });
    const openSelect = selectsOf(openDatabase.calls)[0];
    expect(whereColumns(openSelect ?? {})).toEqual(expect.arrayContaining(["state", "issue_number"]));
    expect(renderSql(openSelect?.where)).toContain("<");
    expect(paramsOf(openSelect?.where)).toContain("9");
  });

  // 关键词只匹配标题，且 LIKE 元字符必须转义：否则用户输入的 `%` 会变成「任意串」，同一关键词给出不同结果集。
  test("listPage 转义模糊匹配的元字符", async () => {
    const database = useDatabase();
    const repository = createTicketIndexRepository();

    await repository.listPage({ projectId: "project-1", limit: 30, q: "100%_done" });

    const select = selectsOf(database.calls)[0];
    expect(paramsOf(select?.where)).toContain("%100\\%\\_done%");
    expect(renderSql(select?.where)).toContain("ilike");
  });

  // 标签过滤用 jsonb 包含（`label_ids @> [labelId]`），负责人过滤按归属列等值匹配。
  test("listPage 用 jsonb 包含过滤标签", async () => {
    const database = useDatabase();
    const repository = createTicketIndexRepository();

    await repository.listPage({ projectId: "project-1", limit: 30, labelId: "bug", assigneeId: "user-1" });

    const select = selectsOf(database.calls)[0];
    expect(renderSql(select?.where)).toContain("@>");
    expect(paramsOf(select?.where)).toContain(JSON.stringify(["bug"]));
    expect(whereColumns(select ?? {})).toEqual(expect.arrayContaining(["label_ids", "assignee_id"]));
  });

  // 计数只按项目聚合，用于「项目下已索引多少工单」的展示与排障。
  test("countByProject 只按项目聚合", async () => {
    const database = useDatabase({ selectRows: { ticket_index: [{ total: 3 }] } });
    const repository = createTicketIndexRepository();

    expect(await repository.countByProject("project-1")).toBe(3);
    expect(whereColumns(selectsOf(database.calls)[0] ?? {})).toEqual(["project_id"]);
  });
});
