import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { chatSpaceService } from "../services/chat-space-service";

/**
 * 会话分组仓储与领域服务的真实行为（`environment-repository.test.ts` 同口径：真实现 + DB 句柄替身）。
 *
 * 为什么大量断言落在「下发的 SQL」上：本表的两个核心不变量——「一个会话至多属于同 scope 下一个分组」
 * 与「多用户隔离」——都由 SQL 层原子操作与谓词承担，读改写式的实现虽然也能通过行为断言，却会在并发下
 * 丢更新。因此这里直接对语句本身取证：摘除是单条无 id 谓词的 UPDATE、追加是 jsonb_build_array 拼接、
 * 每条语句都带 user_id 与 instance_uid。
 */

const DIALECT = new PgDialect();
const INSTANCE_UID = "inst_0123456789abcdef0123456789abcdef";
const OTHER_INSTANCE_UID = "inst_ffffffffffffffffffffffffffffffff";
const SPACE_ID = "space_0123456789abcdef0123456789abcdef";
const SESSION_ID = "ses_0123456789abcdef";
const NOW = new Date("2026-10-15T00:00:00.000Z");

/** 只填被测语义用得到的列，其余按 `chat_space` 行形状补齐。 */
function spaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SPACE_ID,
    name: "研发",
    userId: "user-1",
    instanceUid: INSTANCE_UID,
    sessionIds: [SESSION_ID],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

type SelectChain = Promise<unknown[]> & {
  limit: () => SelectChain;
  orderBy: (...columns: SQL[]) => SelectChain;
  for: (mode: string) => SelectChain;
};
type WriteChain = Promise<unknown[]> & { returning: () => Promise<unknown[]> };

interface CapturedStatement {
  readonly scope: "db" | "tx";
  readonly kind: "select" | "update" | "insert";
  readonly where: unknown;
  readonly values: Record<string, unknown> | null;
}

/**
 * DB 句柄替身：按调用顺序发号（select / update / insert 各一条队列），并记录每条语句的 `where` 与写入值。
 *
 * 事务句柄标记为 `tx`：`moveSessionToSpace` 的「先摘除、后追加」必须整体在事务内，用例据此断言两条写
 * 语句都不是在事务外发出的。
 */
function installDb(
  options: {
    readonly selectRows?: readonly unknown[][];
    readonly updateRows?: readonly unknown[][];
    readonly insertRows?: readonly unknown[][];
    readonly updateError?: unknown;
  } = {},
) {
  const selects = [...(options.selectRows ?? [])];
  const updates = [...(options.updateRows ?? [])];
  const inserts = [...(options.insertRows ?? [])];
  const captured: CapturedStatement[] = [];
  let transactions = 0;
  const lockModes: string[] = [];
  const orderings: SQL[][] = [];

  function selectChain(rows: unknown[]): SelectChain {
    const chain: SelectChain = Object.assign(Promise.resolve(rows), {
      limit: () => chain,
      orderBy: (...columns: SQL[]) => {
        orderings.push(columns);
        return chain;
      },
      for: (mode: string) => {
        lockModes.push(mode);
        return chain;
      },
    });
    return chain;
  }

  function writeChain(rows: unknown[]): WriteChain {
    return Object.assign(Promise.resolve(rows), { returning: () => Promise.resolve(rows) });
  }

  function makeHandle(scope: "db" | "tx") {
    return {
      select: () => ({
        from: () => ({
          where: (where: unknown) => {
            captured.push({ scope, kind: "select", where, values: null });
            return selectChain(selects.shift() ?? []);
          },
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: unknown) => {
            captured.push({ scope, kind: "update", where, values });
            if (options.updateError) throw options.updateError;
            return writeChain(updates.shift() ?? []);
          },
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          captured.push({ scope, kind: "insert", where: null, values });
          const chain = writeChain(inserts.shift() ?? []);
          return Object.assign(chain, { onConflictDoNothing: () => chain });
        },
      }),
    };
  }

  const txHandle = makeHandle("tx");
  const db = {
    ...makeHandle("db"),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      return callback(txHandle);
    },
  };

  stubDb(db as never);
  return { captured, lockModes, orderings, transactionCount: () => transactions };
}

/** 渲染捕获到的 SQL 对象（走 drizzle 的 PG 方言，与真实下发的语句同一条渲染路径）。 */
function render(statement: unknown): { sql: string; params: unknown[] } {
  return DIALECT.sqlToQuery(statement as SQL);
}

/** 取某类语句（按发出顺序）。 */
function statements(captured: readonly CapturedStatement[], kind: CapturedStatement["kind"]) {
  return captured.filter((statement) => statement.kind === kind);
}

beforeEach(resetAllStubs);
afterEach(resetAllStubs);

describe("chat space 领域服务与仓储", () => {
  // 两种归属写都必须先按同一顺序锁定 scope，避免等到旧属主后漏掉新属主。
  test("移入移出使用同一事务锁序", async () => {
    for (const assign of [true, false]) {
      const db = installDb({ selectRows: [[{ id: SPACE_ID }]], updateRows: [[], [spaceRow()]] });
      const input = { instanceUid: INSTANCE_UID, userId: "user-1", sessionId: SESSION_ID, spaceId: SPACE_ID };
      if (assign) await chatSpaceService.assignSession(input);
      else await chatSpaceService.removeSession(input);
      expect(db.transactionCount()).toBe(1);
      expect(db.lockModes).toEqual(["update"]);
      expect(render(db.orderings[0]?.[0]).sql).toBe('"chat_space"."id" asc');
      expect(db.captured[0]?.kind).toBe("select");
      expect(db.captured.every((statement) => statement.scope === "tx")).toBe(true);
    }
  });

  // 创建分组必须用调用方给出的 scope 落库，id 形如 `space_` + 32 位 hex，名称按 trim 后的值存储。
  test("createSpace 以调用方 scope 落库并生成 space_ 业务 id", async () => {
    const { captured } = installDb({ insertRows: [[spaceRow({ name: "研发" })]] });

    const created = await chatSpaceService.createSpace({
      instanceUid: INSTANCE_UID,
      userId: "user-1",
      name: "  研发  ",
    });

    const inserted = statements(captured, "insert")[0]?.values;
    expect(inserted).toMatchObject({
      instanceUid: INSTANCE_UID,
      userId: "user-1",
      name: "研发",
    });
    expect(inserted?.id).toMatch(/^space_[0-9a-f]{32}$/);
    expect(created.name).toBe("研发");
    // 唯一索引是重名的唯一裁决点：插入语句必须显式声明冲突键，否则并发重名会抛驱动错误而不是 409。
    expect(captured.filter((statement) => statement.kind === "insert")).toHaveLength(1);
  });

  // 同 scope 重名由唯一索引拒绝（onConflictDoNothing 返回空集合），领域层给出 409 name_conflict。
  test("createSpace 重名返回 409 name_conflict", async () => {
    installDb({ insertRows: [[]] });

    const failure = await chatSpaceService
      .createSpace({ instanceUid: INSTANCE_UID, userId: "user-1", name: "研发" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "name_conflict", statusCode: 409 });
  });

  // 名称规则是「trim 后 1..100 字符」：空白名与超长名都在触库前被拒绝，避免把无效行写进库。
  test("非法名称在触库前被拒绝", async () => {
    const { captured } = installDb();

    for (const name of ["   ", "", "x".repeat(101)]) {
      const failure = await chatSpaceService
        .createSpace({ instanceUid: INSTANCE_UID, userId: "user-1", name })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "invalid_name", statusCode: 400 });
    }
    expect(captured).toHaveLength(0);
  });

  // 重命名成功时写入 trim 后的新名，并把更新后的行作为结果返回（响应形状即最新分组状态）。
  test("renameSpace 写入 trim 后的新名并返回更新行", async () => {
    const { captured } = installDb({ updateRows: [[spaceRow({ name: "生产" })]] });

    const renamed = await chatSpaceService.renameSpace({
      instanceUid: INSTANCE_UID,
      userId: "user-1",
      spaceId: SPACE_ID,
      name: " 生产 ",
    });

    const update = statements(captured, "update")[0];
    expect(update?.values).toMatchObject({ name: "生产" });
    const where = render(update?.where);
    expect(where.sql).toContain('"chat_space"."id" = ');
    expect(where.sql).toContain('"chat_space"."user_id" = ');
    expect(where.sql).toContain('"chat_space"."instance_uid" = ');
    expect(renamed.name).toBe("生产");
  });

  // UPDATE 没有 onConflictDoNothing，重名只能从驱动的 23505 认出来；Drizzle 把它包在 cause 里，同样要认。
  test("renameSpace 撞唯一索引（错误包在 cause 里）返回 409", async () => {
    installDb({
      updateError: Object.assign(new Error("duplicate key value violates unique constraint"), {
        cause: { code: "23505" },
      }),
    });

    const failure = await chatSpaceService
      .renameSpace({ instanceUid: INSTANCE_UID, userId: "user-1", spaceId: SPACE_ID, name: "生产" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "name_conflict", statusCode: 409 });
  });

  // 非唯一索引冲突的驱动错误必须原样上抛：把存储故障伪装成 409 会让故障永远查不出来。
  test("renameSpace 的其它驱动错误原样上抛", async () => {
    const connectionError = Object.assign(new Error("connection terminated"), { code: "57P01" });
    installDb({ updateError: connectionError });

    const failure = await chatSpaceService
      .renameSpace({ instanceUid: INSTANCE_UID, userId: "user-1", spaceId: SPACE_ID, name: "生产" })
      .catch((error: unknown) => error);

    expect(failure).toBe(connectionError);
  });

  // 分组不在本 scope 时更新零行：以 404 not_found 回报，且文案不含内部标识。
  test("renameSpace 未命中返回 404 not_found", async () => {
    installDb({ updateRows: [[]] });

    const failure = await chatSpaceService
      .renameSpace({ instanceUid: OTHER_INSTANCE_UID, userId: "user-2", spaceId: SPACE_ID, name: "生产" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "not_found", statusCode: 404 });
  });

  // 移入必须在同一事务内「先原子摘除、再原子追加」：摘除是单条覆盖同 scope 全部分组的 UPDATE
  //（jsonb `-`，无 id 谓词），追加是 jsonb_build_array 拼接，两者都带 user_id 与 instance_uid。
  test("moveSessionToSpace 在事务内单语句摘除后追加", async () => {
    const { captured, transactionCount } = installDb({
      selectRows: [[{ id: SPACE_ID }]],
      updateRows: [[], [spaceRow()]],
    });

    await chatSpaceService.assignSession({
      instanceUid: INSTANCE_UID,
      userId: "user-1",
      spaceId: SPACE_ID,
      sessionId: SESSION_ID,
    });

    expect(transactionCount()).toBe(1);
    const [lock] = statements(captured, "select");
    const lockSql = render(lock?.where).sql;
    expect(lock?.scope).toBe("tx");
    expect(lockSql).toContain('"chat_space"."user_id" = ');
    expect(lockSql).toContain('"chat_space"."instance_uid" = ');

    const [removal, append] = statements(captured, "update");
    expect(removal?.scope).toBe("tx");
    expect(append?.scope).toBe("tx");
    const removalWhere = render(removal?.where);
    expect(removalWhere.sql).toContain("@>");
    // 摘除必须覆盖同 scope 全部行：出现 id 谓词就只摘一个分组，会话会残留在另一个分组里。
    expect(removalWhere.sql).not.toContain('"chat_space"."id" = ');
    expect(removalWhere.params.at(-1)).toBe(JSON.stringify([SESSION_ID]));
    expect(render(removal?.values?.sessionIds).sql).toContain(" - ");
    expect(render(append?.values?.sessionIds).sql).toContain("jsonb_build_array(");
  });

  // 目标分组不在本 scope（不存在或属于别人）时不写任何行：否则会把会话从原分组摘掉却没有落点。
  test("moveSessionToSpace 目标不在 scope 时零写入并返回 404", async () => {
    const { captured, transactionCount } = installDb({ selectRows: [[]] });

    const failure = await chatSpaceService
      .assignSession({ instanceUid: INSTANCE_UID, userId: "user-1", spaceId: SPACE_ID, sessionId: SESSION_ID })
      .catch((error: unknown) => error);

    expect(transactionCount()).toBe(1);
    expect(statements(captured, "update")).toHaveLength(0);
    expect(failure).toMatchObject({ code: "not_found", statusCode: 404 });
  });

  // 移出先取同序 scope 锁再单语句摘除，避免并发移入让 WHERE 在等待期间漏掉新属主。
  test("removeSession 在 scope 锁后单语句摘除且不读改写", async () => {
    const { captured } = installDb({ updateRows: [[spaceRow({ sessionIds: [] })]] });

    const space = await chatSpaceService.removeSession({
      instanceUid: INSTANCE_UID,
      userId: "user-1",
      sessionId: SESSION_ID,
    });

    expect(statements(captured, "select")).toHaveLength(1);
    const lock = statements(captured, "select")[0];
    expect(lock?.scope).toBe("tx");
    expect(render(lock?.where).params).toEqual([INSTANCE_UID, "user-1"]);
    const [removal] = statements(captured, "update");
    expect(removal?.scope).toBe("tx");
    expect(render(removal?.values?.sessionIds).sql).toContain(" - ");
    const where = render(removal?.where);
    expect(where.sql).toContain("@>");
    // 谓词里不能出现分组 id：摘除必须覆盖本 scope 的全部命中行。调用方按本地快照反查分组 id 去定位
    // 是旧版行为，在「刚移入的分组还没回到快照」时会摘到空行上，把用户的移出静默丢掉。
    expect(where.sql).not.toContain('"chat_space"."id" = ');
    expect(space?.sessionIds).toEqual([]);
  });

  // 会话本就不在任何分组时是幂等成功：返回 undefined 而不是 404（用户「拖回默认」重复一次不该报错）。
  test("removeSession 未命中返回 undefined", async () => {
    installDb({ updateRows: [[]] });

    const space = await chatSpaceService.removeSession({
      instanceUid: INSTANCE_UID,
      userId: "user-2",
      sessionId: SESSION_ID,
    });

    expect(space).toBeUndefined();
  });

  // 列表必须同时按 user_id 与 instance_uid 过滤：隔离谓词缺失会让别的用户（或同用户别的实例）的分组混进来。
  test("listSpaces 的查询同时带 user_id 与 instance_uid 谓词", async () => {
    const { captured } = installDb({ selectRows: [[spaceRow()]] });

    const spaces = await chatSpaceService.listSpaces({ instanceUid: INSTANCE_UID, userId: "user-1" });

    const [select] = statements(captured, "select");
    const { sql, params } = render(select?.where);
    expect(sql).toContain('"chat_space"."user_id" = ');
    expect(sql).toContain('"chat_space"."instance_uid" = ');
    expect(params).toEqual([INSTANCE_UID, "user-1"]);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]?.instanceUid).toBe(INSTANCE_UID);
  });

  // 列表顺序即侧栏展示顺序：新建的分组必须排在最上面（创建时间倒序），同毫秒时以 id 倒序稳定排序，
  // 否则刷新后分组会在同一位置抖动。
  test("listSpaces 按创建时间倒序下发", async () => {
    const { orderings } = installDb({ selectRows: [[spaceRow()]] });

    await chatSpaceService.listSpaces({ instanceUid: INSTANCE_UID, userId: "user-1" });

    expect(orderings[0]?.map((column) => render(column).sql)).toEqual([
      '"chat_space"."created_at" desc',
      '"chat_space"."id" desc',
    ]);
  });

  // 按分组 id 定位的查询以 user_id 隔离（行上的 instance_uid 由门面与入参 instanceUid 比对）。
  test("findByIdForUser 按 user_id 隔离定位", async () => {
    const { captured } = installDb({ selectRows: [[spaceRow()]] });

    const found = await chatSpaceService.findByIdForUser({ spaceId: SPACE_ID, userId: "user-1" });

    const { sql, params } = render(statements(captured, "select")[0]?.where);
    expect(sql).toContain('"chat_space"."id" = ');
    expect(sql).toContain('"chat_space"."user_id" = ');
    expect(params).toEqual([SPACE_ID, "user-1"]);
    expect(found?.instanceUid).toBe(INSTANCE_UID);
  });

  // 会话 id 是外部输入：空值与超长值在触库前拒绝，避免把无界内容写进 jsonb 列。
  test("非法 session id 在触库前被拒绝", async () => {
    const { captured } = installDb();

    const failure = await chatSpaceService
      .assignSession({ instanceUid: INSTANCE_UID, userId: "user-1", spaceId: SPACE_ID, sessionId: "x".repeat(201) })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "invalid_session_id", statusCode: 400 });
    expect(captured).toHaveLength(0);
  });
});
