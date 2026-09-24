import { beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getPublicationState, publishVersion, unpublishVersion } from "../server/services/plugin-catalog-service";
import {
  digestOf,
  publishCommandFor,
  snapshotJsonOf,
  TEST_IDENTITY,
  TEST_PACKAGE_NAME,
  unpublishCommandFor,
} from "./catalog-harness";

/**
 * 目录事务的**存储侧**契约：锁的时机、写清单到 SQL 的映射、只读路径不加锁。
 *
 * 规则本身由 `plugin-catalog-service.test.ts` 在内存底座上逐条断言，这里只管那些只有真实现才有的性质——
 * 尤其是「咨询锁在任何读之前取」：它取早了只是多一次等待，取晚了会让两个并发发布各自读到「包不存在」，
 * 一方撞唯一索引失败（表现为 500）。这条顺序无法从内存底座验证，因此用替身记录调用序。
 *
 * 替身是**记录器 + 预制行**，不是玩具数据库：它不执行 SQL，只回答「调用方按什么顺序、对哪张表、写了哪些
 * 列」。SQL 约束（唯一索引、复合外键、CHECK）不在本文件的覆盖范围内——测试进程里没有 Postgres，它们由
 * `db/schema.ts` 的声明与迁移评审承担。
 *
 * `stubDb` + `initializeTestApplicationInfrastructure` 的组合是本仓库既有的注入路径：`getDatabase()`
 * 在「基础设施未初始化且用例登记过替身」时回退到替身。必须初始化而不能只 `stubDb`：同一进程里别的测试
 * 文件可能已经把基础设施初始化成它们自己的句柄，此时 `getDatabase()` 会返回那个句柄而不是本用例的替身。
 */

type RecordedCall =
  | { readonly kind: "transaction" }
  | { readonly kind: "execute"; readonly sql: string; readonly params: readonly unknown[] }
  | { readonly kind: "select"; readonly table: string }
  | { readonly kind: "insert"; readonly table: string; readonly values: Record<string, unknown> }
  | { readonly kind: "update"; readonly table: string; readonly values: Record<string, unknown> };

type Row = Record<string, unknown>;

const tableNameOf = (table: unknown): string => getTableName(table as never);

/** 把 Drizzle 的 SQL 对象还原成可读文本与参数，供断言锁语句与锁键。 */
const dialect = new PgDialect();
const describeStatement = (statement: SQL): { sql: string; params: unknown[] } => {
  const query = dialect.sqlToQuery(statement);
  return { sql: query.sql, params: query.params };
};

/**
 * 造一个替身 DB：链式调用被记录，查询返回预制行。
 *
 * 只实现本包使用的四种调用（`transaction` / `execute` / `select` / `insert` / `update`）。`select` 的返回值
 * 特意做成「可 await 的链式对象」——生产代码会链到 `where(...)` 或 `limit(1)` 之后直接 await。
 */
function createFakeDatabase(rowsByTable: Record<string, readonly Row[]>) {
  const calls: RecordedCall[] = [];

  const selectable = (table: string) => {
    const builder: Record<string, unknown> = {};
    builder.where = () => builder;
    builder.limit = () => builder;
    // biome-ignore lint/suspicious/noThenProperty: 生产代码把该链式对象直接 await，替身必须真的可 await——「像 promise 一样被 await」正是它要复刻的行为，不是意外。
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rowsByTable[table] ?? []).then(resolve, reject);
    return builder;
  };

  const tx = {
    execute: async (statement: SQL) => {
      const { sql, params } = describeStatement(statement);
      calls.push({ kind: "execute", sql, params });
      return [];
    },
    select: () => ({
      from: (table: unknown) => {
        const name = tableNameOf(table);
        calls.push({ kind: "select", table: name });
        return selectable(name);
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        calls.push({ kind: "insert", table: tableNameOf(table), values });
        return [];
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          calls.push({ kind: "update", table: tableNameOf(table), values });
          return [];
        },
      }),
    }),
  };

  return {
    calls,
    transaction: async <T>(fn: (handle: typeof tx) => Promise<T>): Promise<T> => {
      calls.push({ kind: "transaction" });
      return fn(tx);
    },
    // 只读查询走普通句柄（`getPluginMarketDatabase()`），不经过事务。
    select: tx.select,
  };
}

/** 用例里的固定时刻：断言写入的时间戳必须用它，因此不能在测试里取 `new Date()`。 */
const NOW = new Date("2026-03-01T12:00:00.000Z");
const EARLIER = new Date("2026-02-01T12:00:00.000Z");

const PACKAGE_ROW: Row = {
  id: "pkg-1",
  sourceId: TEST_IDENTITY.sourceId,
  packageName: TEST_PACKAGE_NAME,
  organizationId: "org-test",
  ownerUserId: "user-test",
  visibility: "public",
  latestPublicationId: "pub-latest",
  createdAt: EARLIER,
  updatedAt: EARLIER,
};

const publicationRow = (input: {
  id: string;
  version: string;
  publishedAt: Date;
  unpublishedAt?: Date | null;
}): Row => ({
  id: input.id,
  packageId: "pkg-1",
  exactVersion: input.version,
  metadataJson: snapshotJsonOf(input.version),
  metadataDigest: digestOf(input.version),
  firstPublishedAt: input.publishedAt,
  publishedAt: input.publishedAt,
  unpublishedAt: input.unpublishedAt ?? null,
  createdAt: input.publishedAt,
  updatedAt: input.publishedAt,
});

/** 写语句（insert / update）的形状与顺序；`noop` 断言靠它为空。 */
const writesOf = (calls: readonly RecordedCall[]): RecordedCall[] =>
  calls.filter((call) => call.kind === "insert" || call.kind === "update");

/** 写语句的「种类:表名」序列，用于断言落库顺序。 */
const writeShapesOf = (calls: readonly RecordedCall[]): string[] =>
  writesOf(calls).map((call) =>
    call.kind === "insert" || call.kind === "update" ? `${call.kind}:${call.table}` : call.kind,
  );

let database: ReturnType<typeof createFakeDatabase>;

/** 用给定行集合装配替身 DB；未给到的表视为空表。 */
const useDatabase = (rowsByTable: Record<string, readonly Row[]> = {}): void => {
  resetAllStubs();
  database = createFakeDatabase(rowsByTable);
  stubDb(database);
  initializeTestApplicationInfrastructure();
};

beforeEach(() => {
  useDatabase();
});

describe("transaction boundary", () => {
  // 整个「读—判断—写」必须在一个事务里、且**先取咨询锁再读**：读在锁之前会让并发发布各自读到不存在的包。
  test("takes the advisory lock before reading any state, inside one transaction", async () => {
    useDatabase({
      plugin_market_package: [PACKAGE_ROW],
      plugin_market_publication: [publicationRow({ id: "pub-latest", version: "1.0.0", publishedAt: NOW })],
    });

    await unpublishVersion(unpublishCommandFor("1.0.0"), NOW);

    const kinds = database.calls.map((call) => call.kind);
    expect(kinds[0]).toBe("transaction");
    expect(kinds[1]).toBe("execute");
    expect(kinds[2]).toBe("select");

    const lock = database.calls[1];
    if (lock?.kind !== "execute") throw new Error("第二次调用应当是咨询锁");
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    // 锁键必须能区分来源与包名：少了任何一段，两个不同的包会共用一把锁（互相阻塞），或同一个包拿到两把锁
    // （等于没有互斥）。
    expect(lock.params).toEqual([`fenix:plugin-market:${TEST_IDENTITY.sourceId}:${TEST_PACKAGE_NAME}`]);
  });

  // 只读的状态查询不开事务、不加锁：它只用于「要不要回源重读 registry」的分派，为它序列化整个包的写入没有意义。
  test("reads publication state without taking the lock", async () => {
    useDatabase({ plugin_market_package: [PACKAGE_ROW], plugin_market_publication: [] });

    const state = await getPublicationState(TEST_IDENTITY, "1.0.0");

    expect(state.state).toBe("missing");
    expect(database.calls.map((call) => call.kind)).toEqual(["select", "select"]);
  });

  // 包不存在时只读查询也不该去读版本行：没有聚合根就没有版本的归属，第二次查询永远返回空。
  test("skips the publication lookup when the package does not exist", async () => {
    useDatabase();

    expect((await getPublicationState(TEST_IDENTITY, "1.0.0")).state).toBe("missing");
    expect(database.calls.map((call) => call.kind)).toEqual(["select"]);
  });
});

describe("write mapping", () => {
  // 新建包的写清单必须按「建聚合根 → 插版本行 → 回填 latest」落库：顺序反了会撞复合外键（指针指向还不存在的版本行）。
  test("creates the package, then the publication, then points latest at it", async () => {
    await publishVersion(publishCommandFor("1.0.0"), NOW);

    const writes = writesOf(database.calls);
    expect(writeShapesOf(database.calls)).toEqual([
      "insert:plugin_market_package",
      "insert:plugin_market_publication",
      "update:plugin_market_package",
      // 审计与目录变更在同一个事务里，且只在真实变更时写。
      "insert:plugin_market_admin_operation",
    ]);

    const created = writes[0];
    const publication = writes[1];
    if (created?.kind !== "insert" || publication?.kind !== "insert") throw new Error("前两条写语句应当是两次插入");
    // 聚合根插入时指针必须为空：复合外键要求它指向的版本行已经在库里，而版本行还没写。
    expect(created.values.latestPublicationId).toBeNull();
    // 市场条目按定义就是公开可读：这一列若取授权模块对组织资源的默认值（`private`），整个目录会对所有
    // 非系统管理员静默消失，且不报任何错。
    expect(created.values.visibility).toBe("public");
    expect(created.values.organizationId).toBe("org-test");
    expect(publication.values.packageId).toBe(created.values.id);

    const pointer = writes[2];
    if (pointer?.kind !== "update") throw new Error("末条写语句应当是移动 latest");
    expect(pointer.values.latestPublicationId).toBe(publication.values.id);
    expect(pointer.values.updatedAt).toEqual(NOW);
  });

  // 下架 latest 时**先移指针再置水印**：写清单的数组顺序就是这个顺序，仓储不得重排或合并。
  test("moves the latest pointer before stamping the watermark", async () => {
    useDatabase({
      plugin_market_package: [PACKAGE_ROW],
      plugin_market_publication: [
        publicationRow({ id: "pub-latest", version: "1.1.0", publishedAt: NOW }),
        publicationRow({ id: "pub-older", version: "1.0.0", publishedAt: EARLIER }),
      ],
    });

    const change = await unpublishVersion(unpublishCommandFor("1.1.0"), NOW);

    const writes = writesOf(database.calls);
    expect(writes[0]).toMatchObject({
      kind: "update",
      table: "plugin_market_package",
      values: { latestPublicationId: "pub-older", updatedAt: NOW },
    });
    // 置水印必须排在移指针之后：反过来的话事务内存在「latest 指向一个已隐藏版本」的中间态。
    expect(writes[1]).toMatchObject({
      kind: "update",
      table: "plugin_market_publication",
      values: { publishedAt: NOW, unpublishedAt: NOW, updatedAt: NOW },
    });
    expect(change.latestPublicationId).toBe("pub-older");

    // 审计与目录变更在同一个事务里：只写目录不写流水，事后无法回答「谁动过市场」。
    const audit = writes[2];
    expect(audit).toMatchObject({ kind: "insert", table: "plugin_market_admin_operation" });
    expect(audit?.kind === "insert" ? audit.values.action : null).toBe("unpublish");
    expect(audit?.kind === "insert" ? audit.values.operatorUserId : null).toBe("user-test");
  });

  // 更新版本行只允许写可变列：快照列一旦进入 UPDATE，「快照发布后不可变」就只剩一句注释。
  test("never writes snapshot columns when updating a publication", async () => {
    useDatabase({
      plugin_market_package: [PACKAGE_ROW],
      plugin_market_publication: [publicationRow({ id: "pub-latest", version: "1.1.0", publishedAt: NOW })],
    });

    await unpublishVersion(unpublishCommandFor("1.1.0"), NOW);

    const publicationUpdate = writesOf(database.calls).find(
      (call) => call.kind === "update" && call.table === "plugin_market_publication",
    );
    if (publicationUpdate?.kind !== "update") throw new Error("应当有一条版本行更新");
    expect(Object.keys(publicationUpdate.values).sort()).toEqual(["publishedAt", "unpublishedAt", "updatedAt"]);
    expect(publicationUpdate.values.unpublishedAt).toEqual(NOW);
  });

  // 幂等分支必须产生**零写语句**：领域侧断言写清单为空，这里断言空清单确实不落到任何 SQL。
  test("emits no write statement for a no-op publish", async () => {
    useDatabase({
      plugin_market_package: [PACKAGE_ROW],
      plugin_market_publication: [publicationRow({ id: "pub-latest", version: "1.0.0", publishedAt: NOW })],
    });

    const change = await publishVersion(publishCommandFor("1.0.0"), NOW);

    expect(change.action).toBe("noop");
    expect(writesOf(database.calls)).toEqual([]);
  });

  // 恢复路径写的是库内快照：即使调用方带来另一份元数据，UPDATE 也不得改快照列（内容不同的发布必须先下架）。
  test("keeps the stored snapshot when restoring a hidden version", async () => {
    useDatabase({
      plugin_market_package: [PACKAGE_ROW],
      plugin_market_publication: [
        publicationRow({
          id: "pub-hidden",
          version: "1.0.0",
          publishedAt: EARLIER,
          unpublishedAt: EARLIER,
        }),
      ],
    });

    const change = await publishVersion(
      publishCommandFor("1.0.0", {
        metadataJson: snapshotJsonOf("1.0.0", "另一份内容"),
        metadataDigest: digestOf("x"),
      }),
      NOW,
    );

    expect(change.action).toBe("restore");
    const publicationUpdate = writesOf(database.calls).find(
      (call) => call.kind === "update" && call.table === "plugin_market_publication",
    );
    if (publicationUpdate?.kind !== "update") throw new Error("恢复必须写版本行（水印与时刻）");
    expect(Object.keys(publicationUpdate.values).sort()).toEqual(["publishedAt", "unpublishedAt", "updatedAt"]);
    expect(publicationUpdate.values.unpublishedAt).toBeNull();
    expect(publicationUpdate.values.publishedAt).toEqual(NOW);
  });
});
