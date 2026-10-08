import { afterEach, describe, expect, test } from "bun:test";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  getDatabase,
  getModuleConfig,
  getRedisConnection,
  initializeApplicationInfrastructure,
  overrideModuleConfig,
  resetApplicationInfrastructure,
  runInTransaction,
} from "../server";

const POSTGRES_DIALECT = new PgDialect();

interface TestTransaction {
  readonly id: number;
  execute(query: SQLWrapper): Promise<void>;
}

interface TestTransactionDatabase {
  readonly events: string[];
  readonly transactions: TestTransaction[];
  transaction<T>(callback: (transaction: TestTransaction) => Promise<T>): Promise<T>;
}

type ExecuteHook = (query: SQLWrapper, sqlText: string) => Promise<void>;

/** 创建记录事务边界与语句执行的最小数据库替身。 */
function createTestTransactionDatabase(executeHook?: ExecuteHook): TestTransactionDatabase {
  const events: string[] = [];
  const transactions: TestTransaction[] = [];

  return {
    events,
    transactions,
    async transaction<T>(callback: (transaction: TestTransaction) => Promise<T>): Promise<T> {
      const transaction: TestTransaction = {
        id: transactions.length + 1,
        async execute(query: SQLWrapper): Promise<void> {
          const sqlText = POSTGRES_DIALECT.sqlToQuery(query.getSQL()).sql;
          events.push(sqlText);
          await executeHook?.(query, sqlText);
        },
      };
      transactions.push(transaction);
      events.push("begin");

      try {
        const result = await callback(transaction);
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };
}

/** 创建可由测试显式放行的 Promise 屏障。 */
function createDeferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetApplicationInfrastructure();
});

describe("application infrastructure", () => {
  // 模块早于宿主初始化读取基础设施属于装配错误，必须显式报错而不是返回 undefined。
  //
  // 模块 ID 必须用宿主 preload 永不登记的哨兵值（下面第 2 条用例的 `access-control` 与初始化用例里的
  // 模块 ID 只是普通示例）。宿主测试进程的 `@fenix/platform-sdk/server` 替身会把**已登记**模块的读取
  // 回退到替身基线（`apps/server/src/test-utils/setup-mocks.ts` 的 `getModuleConfig` 包装），因此任何真实
  // 模块 ID——包括 1.4 W1 起登记了基线的 `agent-runtime`——在这里都读不出「未初始化」这一状态，
  // 断言会静默失去意义（实测：用 `agent-runtime` 时本用例由失败变为读到基线值）。
  //
  // `getRedisConnection()` 的同类契约无法在此断言，原因同上：宿主 preload 的替身对 Redis 也接了
  // 「未初始化回退到宿主 `services/cache`」的 seam（否则测试进程里 DocManager 与会话快照路径会全线
  // 抛错），实测该断言读到的是替身回退值 `null` 而不是错误。契约由同一个 `requireInfrastructure()`
  // 保证，与上面两条断言同一条实现路径。
  test("未初始化时读取 DB 与模块配置都失败", () => {
    expect(() => getDatabase()).toThrow("应用基础设施尚未初始化");
    expect(() => getModuleConfig("never-registered-module")).toThrow("应用基础设施尚未初始化");
  });

  // 宿主唯一初始化后，DB 与各模块配置按模块 ID 精确可读。
  test("按模块 ID 读取已注册的配置和 DB", () => {
    const database = { kind: "database" };
    initializeApplicationInfrastructure({
      database,
      moduleConfigs: { "agent-runtime": { SANDBOX_URL: "http://sandbox" } },
      redisConnection: null,
    });

    expect(getDatabase()).toBe(database);
    expect(getModuleConfig<{ SANDBOX_URL: string }>("agent-runtime")).toEqual({ SANDBOX_URL: "http://sandbox" });
  });

  // Redis 是可选基础设施：声明 null 表示本进程不用它，读取得到 null 而不是抛错。provider 每次读取
  // 都重新调用——宿主的 cache.ts 首次 getCache() 才建连，注册期取值会把「未连」固化成永久 null。
  test("Redis provider 声明 null 时读取为 null，且每次读取都重新取值", () => {
    let connection: unknown = null;
    initializeApplicationInfrastructure({
      database: {},
      moduleConfigs: {},
      redisConnection: () => connection,
    });

    expect(getRedisConnection()).toBeNull();

    // 模拟宿主首次 getCache() 后完成建连：同一份基础设施应能读到新连接，无需重新初始化。
    connection = { kind: "redis" };
    expect(getRedisConnection()).toEqual({ kind: "redis" });
  });

  // 一个进程只允许一个 DB client 和一套配置，重复初始化必须失败。
  test("拒绝重复初始化", () => {
    initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null });
    expect(() =>
      initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null }),
    ).toThrow("应用基础设施已初始化，禁止重复初始化");
  });

  // 未声明配置的模块不得回退到 process.env 或默认值，必须失败。
  test("读取未声明的模块配置失败", () => {
    initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null });
    expect(() => getModuleConfig("unknown-module")).toThrow("模块 unknown-module 未声明应用基础设施配置");
  });

  // 测试覆盖只能替换目标模块，不能污染其他模块或未初始化状态。
  test("覆盖单个模块配置不影响其他模块", () => {
    initializeApplicationInfrastructure({
      database: {},
      moduleConfigs: { "agent-runtime": { SANDBOX_URL: "http://sandbox" }, "access-control": { AUTH_MODE: "session" } },
      redisConnection: null,
    });

    overrideModuleConfig("agent-runtime", { SANDBOX_URL: "http://test-sandbox" });

    expect(getModuleConfig("agent-runtime")).toEqual({ SANDBOX_URL: "http://test-sandbox" });
    expect(getModuleConfig("access-control")).toEqual({ AUTH_MODE: "session" });
  });

  // 未初始化时覆盖配置会掩盖忘记初始化，必须直接失败。
  test("未初始化时覆盖模块配置失败", () => {
    expect(() => overrideModuleConfig("agent-runtime", {})).toThrow("应用基础设施尚未初始化");
  });

  // reset 必须让状态完全回到未初始化，测试之间才能隔离。
  test("reset 后回到未初始化状态", () => {
    initializeApplicationInfrastructure({
      database: {},
      moduleConfigs: { "agent-runtime": {} },
      redisConnection: null,
    });
    resetApplicationInfrastructure();

    expect(() => getDatabase()).toThrow("应用基础设施尚未初始化");
    expect(() =>
      initializeApplicationInfrastructure({ database: {}, moduleConfigs: {}, redisConnection: null }),
    ).not.toThrow();
  });

  // 根事务回调内应暴露 tx，结束后恢复进程级根数据库。
  test("根 runInTransaction 在回调中暴露 tx 并在完成后恢复根数据库", async () => {
    const database = createTestTransactionDatabase();
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });

    let callbackDatabase: TestTransaction | undefined;
    await runInTransaction(
      async () => {
        callbackDatabase = getDatabase<TestTransaction>();
        expect(callbackDatabase).toBe(database.transactions[0]);
      },
      { timeoutMs: 321 },
    );

    expect(getDatabase<typeof database>()).toBe(database);
    expect(database.events).toEqual(["begin", "SET LOCAL statement_timeout = '321ms'", "commit"]);
  });

  // REQUIRED 嵌套事务复用外层 tx，并只收紧语句超时。
  test("嵌套 REQUIRED 事务复用同一 tx 并收紧超时", async () => {
    const database = createTestTransactionDatabase();
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });

    let outerDatabase: TestTransaction | undefined;
    let innerDatabase: TestTransaction | undefined;
    await runInTransaction(
      async () => {
        outerDatabase = getDatabase<TestTransaction>();
        await runInTransaction(
          async () => {
            innerDatabase = getDatabase<TestTransaction>();
          },
          { timeoutMs: 80 },
        );
      },
      { timeoutMs: 321 },
    );

    expect(database.transactions).toHaveLength(1);
    expect(outerDatabase).toBe(database.transactions[0]);
    expect(innerDatabase).toBe(database.transactions[0]);
    expect(database.events).toEqual([
      "begin",
      "SET LOCAL statement_timeout = '321ms'",
      "SET LOCAL statement_timeout = '80ms'",
      "commit",
    ]);
  });

  // 并发嵌套调用必须共享已同步收紧的范围，不能由较宽的后续调用重新放宽数据库超时。
  test("并发嵌套 REQUIRED 事务不会放宽已收紧的超时", async () => {
    const statement80Started = createDeferred();
    const releaseStatement80 = createDeferred();
    const database = createTestTransactionDatabase(async (_query, sqlText) => {
      if (sqlText === "SET LOCAL statement_timeout = '80ms'") {
        statement80Started.resolve();
        await releaseStatement80.promise;
      }
    });
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });

    await runInTransaction(
      async () => {
        const inner80 = runInTransaction(async () => undefined, { timeoutMs: 80 });
        await statement80Started.promise;
        const inner160 = runInTransaction(async () => undefined, { timeoutMs: 160 });
        await inner160;
        releaseStatement80.resolve();
        await Promise.all([inner80, inner160]);
      },
      { timeoutMs: 321 },
    );

    expect(database.transactions).toHaveLength(1);
    expect(database.events).toEqual([
      "begin",
      "SET LOCAL statement_timeout = '321ms'",
      "SET LOCAL statement_timeout = '80ms'",
      "commit",
    ]);
  });

  // 回调失败必须原样拒绝，并由根事务回滚。
  test("回调抛错时回滚并拒绝同一错误", async () => {
    const database = createTestTransactionDatabase();
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });
    const expectedError = new Error("expected failure");

    await expect(
      runInTransaction(async () => {
        throw expectedError;
      }),
    ).rejects.toBe(expectedError);

    expect(database.events).toEqual(["begin", "SET LOCAL statement_timeout = '10000ms'", "rollback"]);
  });

  // 未指定 timeout 时应使用 10000ms 的默认 statement_timeout。
  test("省略 timeout 时使用默认 statement_timeout", async () => {
    const database = createTestTransactionDatabase();
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });

    await runInTransaction(async () => undefined);

    expect(database.events).toEqual(["begin", "SET LOCAL statement_timeout = '10000ms'", "commit"]);
  });

  // 非正、非整数或非有限 timeout 必须在开启事务前拒绝。
  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("非法 timeout %p 在开启事务前拒绝", async (timeoutMs) => {
    const database = createTestTransactionDatabase();
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });

    await expect(runInTransaction(async () => undefined, { timeoutMs })).rejects.toThrow();

    expect(database.transactions).toHaveLength(0);
  });

  // 内层超时比外层宽松时不能放宽已生效的 statement_timeout。
  test("内层较宽 timeout 不执行第二次 SET LOCAL", async () => {
    const database = createTestTransactionDatabase();
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });

    await runInTransaction(
      async () => {
        await runInTransaction(async () => undefined, { timeoutMs: 999 });
      },
      { timeoutMs: 80 },
    );

    expect(database.transactions).toHaveLength(1);
    expect(database.events).toEqual(["begin", "SET LOCAL statement_timeout = '80ms'", "commit"]);
  });

  // 并发根事务的 AsyncLocalStorage 上下文必须相互隔离。
  test("并发根事务分别读取各自的 tx", async () => {
    const database = createTestTransactionDatabase();
    initializeApplicationInfrastructure({ database, moduleConfigs: {}, redisConnection: null });
    const bothEntered = createDeferred();
    const release = createDeferred();
    const callbackTransactions: Array<{ readonly before: TestTransaction; readonly after: TestTransaction }> = [];
    let enteredCount = 0;
    const markEntered = (): void => {
      enteredCount += 1;
      if (enteredCount === 2) {
        bothEntered.resolve();
      }
    };

    const first = runInTransaction(async () => {
      const before = getDatabase<TestTransaction>();
      markEntered();
      await release.promise;
      callbackTransactions.push({ before, after: getDatabase<TestTransaction>() });
    });
    const second = runInTransaction(async () => {
      const before = getDatabase<TestTransaction>();
      markEntered();
      await release.promise;
      callbackTransactions.push({ before, after: getDatabase<TestTransaction>() });
    });

    let barrierTimeout: ReturnType<typeof setTimeout> | undefined;
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      await Promise.race([
        bothEntered.promise,
        new Promise<never>((_, reject) => {
          barrierTimeout = setTimeout(() => reject(new Error("并发事务未能同时进入回调")), 1_000);
        }),
      ]);
    } finally {
      if (barrierTimeout) {
        clearTimeout(barrierTimeout);
      }
      release.resolve();
      outcomes = await Promise.allSettled([first, second]);
    }

    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBeTrue();
    expect(database.transactions).toHaveLength(2);
    expect(callbackTransactions[0]?.before).toBe(callbackTransactions[0]?.after);
    expect(callbackTransactions[1]?.before).toBe(callbackTransactions[1]?.after);
    expect(callbackTransactions[0]?.before).not.toBe(callbackTransactions[1]?.before);
  });
});
