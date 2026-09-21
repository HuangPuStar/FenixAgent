/**
 * 部署期数据迁移入口（权威依据：`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.3）。
 *
 * §6.3 末段与 §10.6.2 要求「一次性业务数据迁移只由部署发布任务执行，不在每个应用进程启动时自动执行」。
 * 本文件就是那个发布期入口：宿主启动序（`apps/server/src/bootstrap/host-startup.ts`）不再调用
 * `runDataMigrations()`，改由 release 步骤执行一次
 * `bun run db/data-migration-runner.ts`（镜像内为 `bun data-migration-runner.js`）。
 *
 * 按 §8「`scripts/` 只做薄编排」的口径，本入口只做：静态汇总现有注册表、按注册表声明顺序执行、日志、
 * 失败停止、完成记录归属。以下三件事都不在这里做：
 * - 迁移业务逻辑留在 `apps/server/src/services/data-migrates/*` 与各资源包内；
 * - 幂等跳过与 `data_migrate_record` 完成记录由 `runDataMigrations()` 负责，本文件不复制判定；
 * - `verify` / `compensation` / 迁移指标 / running-failed claim 状态机属 §6.3、§10.6.2 的完成态，
 *   尚未实现（未完成任务，见 review 文档登记），不在本文件先搭框架。
 *
 * 执行顺序与位置约束：
 * - 必须在 DDL 迁移（`migrate.js`）**之后**执行：数据迁移读写新结构，顺序颠倒时会因缺列/缺表失败
 *   （fail-stop，不会静默跳过）；也必须早于新版本应用进程启动。
 * - 不得像 `migrate.js` 那样写进 `docker-compose.yml` 的容器启动命令：那会让每个副本各跑一次，而数据
 *   迁移含文件副作用（skill 归档/复制），重复并发不是纯 DB no-op
 *   （见 `docs/need-to-change/31-gate-release-and-migration.md`）。
 * - 必须挂载与应用进程相同的数据卷（镜像内 `/app/data`，`skillDir` 默认 `./data/skills`）：迁移既写库也
 *   写文件，卷不一致会留下「记录已落库、应用却读不到迁移后文件」的状态，而记录已写入使重跑变成跳过，
 *   无法靠重试自愈。
 */

/** 入口依赖；默认实现动态装载宿主模块，测试可注入替身而不触库。 */
export interface DataMigrationRunnerDeps {
  /** 执行注册表内所有尚未落库的迁移；失败必须抛出，由入口 fail-stop。 */
  runDataMigrations: () => Promise<void>;
  /** 关闭宿主 DB 连接池，避免脚本结束后挂住。 */
  closeDatabase: () => Promise<void>;
  log: (message: string) => void;
  logError: (message: string) => void;
}

/**
 * 掩掉诊断文本里可能出现的 `DATABASE_URL` 原文。
 *
 * 覆盖两种已知回显形态、都是字面匹配：整条连接串、连接串里的口令段。`pg` 对畸形连接串的报错会把原文
 * 带进 message，直接回显等于把口令写进流水线日志。
 *
 * 就地实现而不是抽通用脱敏设施：`@fenix/logger` 的 `scrubSensitive` 已随 4e03cc72b 整批撤回，
 * 本入口按 §8 只做薄编排，不值得为两处日志再造一层抽象。
 */
function maskDatabaseUrlSecrets(text: string, databaseUrl: string | undefined): string {
  if (!databaseUrl) return text;
  const masked = text.split(databaseUrl).join(databaseUrl.replace(/:\/\/[^@/]*@/, "://***:***@"));
  const password = /:\/\/[^@/]*?:([^@/]*)@/.exec(databaseUrl)?.[1];
  return password ? masked.split(password).join("***") : masked;
}

/**
 * 迁移失败诊断文本：保留错误链，但掩掉连接串口令。
 *
 * 展开 `cause` 是有意的：drizzle 的 `DrizzleQueryError` 只把 SQL 放进 message，真正原因（连接被拒、
 * 约束冲突、缺列）挂在 `cause` 上，不展开就只剩「Failed query」这一句，无法定位。
 */
function describeError(err: unknown, databaseUrl: string | undefined): string {
  const parts: string[] = [];
  let current: unknown = err;
  // 最多展开 5 层：足够覆盖 drizzle → pg → socket 这条链，同时挡住自引用 cause 造成的死循环。
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    parts.push(`${current.name}: ${current.message}${current.stack ? `\n${current.stack}` : ""}`);
    current = current.cause;
  }
  if (current !== undefined && current !== null) parts.push(String(current));
  return maskDatabaseUrlSecrets(parts.join("\nCaused by: "), databaseUrl);
}

/**
 * 生产依赖：`DATABASE_URL` 校验通过后才动态装载宿主模块，并按宿主口径完成应用基础设施初始化。
 *
 * 用 `import()` 而不是静态导入：`apps/server/src/db` 在模块求值期就构造 `pg` 连接池，且自身带本地回退
 * 默认连接串；静态导入会让「缺 `DATABASE_URL`」在报错前就已经指向 localhost。
 *
 * 初始化基础设施是必需的，不是可选装饰：迁移读模块配置（skill 迁移读 `skillDir`）并可能经
 * `getDatabase()` 取库，两者都要求宿主先调用 `initializeApplicationInfrastructure()`，否则包侧读取直接抛
 * 「应用基础设施尚未初始化」。这里的两步（`loadServerEnv` → `applyEnv`）与 `apps/server/src/main.ts` 同源，
 * 只是不建 app、不监听端口。因此本入口要求与应用进程**同一份环境变量**（`DATABASE_URL`、`RCS_API_KEYS`
 * 等必填项由 `loadServerEnv` 校验）——这也是必须的：`skillDir` 等路径若与应用解析结果分歧，文件迁移会写到
 * 应用读不到的位置。
 */
async function createProductionDeps(): Promise<DataMigrationRunnerDeps> {
  const [{ client, db }, envLoader, configModule, moduleConfigs, platformSdk, { runDataMigrations }] =
    await Promise.all([
      import("../apps/server/src/db"),
      import("../apps/server/src/env-loader"),
      import("../apps/server/src/config"),
      import("../apps/server/src/bootstrap/module-configs"),
      import("@fenix/platform-sdk/server"),
      import("../apps/server/src/services/data-migrate"),
    ]);

  const env = envLoader.loadServerEnv([]);
  // `applyEnv` 必须早于 `buildModuleConfigs`：后者读的是 `config` 单例（见其文件头注释）。
  configModule.applyEnv(env);
  platformSdk.initializeApplicationInfrastructure({
    database: db,
    // 显式声明「本进程不使用 Redis」：数据迁移只读写 DB 与文件，不碰 Y.Doc 快照等 Redis 能力。
    // 该字段必填而非可选，正是为了让「漏传」与「声明不用」可区分，因此这里必须给 `null` 而不是省略。
    redisConnection: null,
    moduleConfigs: moduleConfigs.buildModuleConfigs(env, configModule.config),
  });

  return {
    runDataMigrations,
    closeDatabase: async () => {
      await client.end();
    },
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  };
}

/**
 * 执行部署期数据迁移并返回进程退出码。
 *
 * 依赖可注入只为可测：测试用替身验证「按记录跳过已应用项」「某个迁移失败即中止且退出码非 0」，
 * 不需要真库。返回值 0 只代表 `runDataMigrations()` 正常返回。
 */
export async function runDataMigrationEntrypoint(deps?: DataMigrationRunnerDeps): Promise<number> {
  let resolved: DataMigrationRunnerDeps;
  try {
    resolved = deps ?? (await createProductionDeps());
  } catch (err) {
    // 依赖尚未就绪时没有注入的 logger：直接写 stderr。错误文本只含变量名与 zod 字段路径，
    // 且同样经 `describeError` 掩掉连接串。
    console.error(`[data-migrate] 部署期运行环境初始化失败：${describeError(err, process.env.DATABASE_URL)}`);
    return 1;
  }

  resolved.log("[data-migrate] 部署期数据迁移开始（已应用的迁移按 data_migrate_record 跳过）。");
  // 掩码用的原值，只参与诊断文本替换，不写入日志。
  const databaseUrl = process.env.DATABASE_URL;
  try {
    await resolved.runDataMigrations();
    resolved.log("[data-migrate] 数据迁移全部完成。");
    return 0;
  } catch (err) {
    resolved.logError(`[data-migrate] 数据迁移失败，后续迁移不再执行：${describeError(err, databaseUrl)}`);
    return 1;
  } finally {
    try {
      await resolved.closeDatabase();
    } catch (err) {
      // 关闭失败不掩盖迁移结果本身：迁移已按记录落库，连接随进程退出回收。
      resolved.logError(`[data-migrate] 关闭数据库连接失败：${describeError(err, databaseUrl)}`);
    }
  }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) {
    console.error("[data-migrate] 缺少必填环境变量 DATABASE_URL（声明见 apps/server/src/env.ts）。");
    process.exit(1);
  }
  // 显式 exit：连接池未能正常关闭时也要让发布任务以确定的状态结束，而不是挂住流水线。
  process.exit(await runDataMigrationEntrypoint());
}
