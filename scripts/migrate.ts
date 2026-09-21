import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

/**
 * 生产 DDL 迁移入口（`Dockerfile` 的 `migrate` stage 与 runtime 镜像里的 `migrate.js`）。
 *
 * **失败一律 fail-closed**：本脚本曾经把「异常 message 含 `already exists`」当作「库是 db:push 建的」而
 * 以退出码 0 结束，于是任何 message 恰好含该子串的真实失败（典型是部分执行后遗留的不一致状态下的
 * `CREATE INDEX ... already exists`）都会被伪装成成功，部署流水线无法失败停止
 * （见 `docs/need-to-change/31-gate-release-and-migration.md`）。
 *
 * 那个容忍之所以「看起来必要」，真实诱因是并发 DDL：`docker-compose.yml` 与
 * `docker/prod/docker-compose.yml` 让每个应用容器启动前各跑一次 `migrate.js`，多副本同时建表会互相
 * 撞出 `already exists`。诱因由 advisory lock 消除（同一常量 key 串行化），不再需要靠吞错兜底。
 *
 * 历史 db:push 建立的库（没有 `drizzle."__drizzle_migrations"` 记录）需要一次显式的基线化，前置步骤见
 * `drizzle/README.md` 场景五。本脚本不做自动基线化：判断「库结构与迁移链是否真的等价」需要结构比对，
 * 而脚本按 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §8 只做薄编排——猜错方向会把
 * 缺失的结构当成已应用。
 */

/**
 * 串行化并发迁移的 advisory lock key。
 *
 * 常量而非随机值：同一数据库上的所有 `migrate.js` 进程必须抢同一把锁。取值本身无业务含义，只要全仓库唯一。
 */
const MIGRATION_ADVISORY_LOCK_KEY = "8241457319283746";

/**
 * 掩掉诊断文本里可能出现的 `DATABASE_URL` 原文。
 *
 * 只覆盖这一个已知取值、两种已知回显形态，且都是字面匹配：整条连接串、连接串里的口令段。
 * `pg` 对畸形 `DATABASE_URL` 的报错会把原文带进 message（`new Pool` 的 `Invalid URL: ...`），
 * 直接回显等于把口令写进流水线日志。
 *
 * 就地实现而不是抽通用脱敏设施：`@fenix/logger` 的 `scrubSensitive` 已随 4e03cc72b 整批撤回，
 * 本入口按 §8 只做薄编排，不值得为两处日志再造一层抽象。
 *
 * 导出仅为可测：口令不落日志是安全要求，需要一条直接断言而不是只靠静态文本检查。
 */
export function maskDatabaseUrlSecrets(text: string, databaseUrl: string | undefined): string {
  if (!databaseUrl) return text;
  const masked = text.split(databaseUrl).join(databaseUrl.replace(/:\/\/[^@/]*@/, "://***:***@"));
  const password = /:\/\/[^@/]*?:([^@/]*)@/.exec(databaseUrl)?.[1];
  return password ? masked.split(password).join("***") : masked;
}

/**
 * 生成错误诊断文本。
 *
 * 保留错误本身（`name` / `message` / `stack`），但把 `DATABASE_URL` 原文掩掉；`message` 之外的字段
 * 不参与拼接，因此不会回显环境取值。
 */
function describeError(err: unknown, databaseUrl: string): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
  return maskDatabaseUrlSecrets(text, databaseUrl);
}

/** 读取必填的 `DATABASE_URL`；缺失时立即失败，不回退到源码里的默认连接串（连接串与口令不得写入源码）。 */
function readDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    console.error(
      "[migrate] 缺少必填环境变量 DATABASE_URL（声明见 apps/server/src/env.ts）；本地开发由 .env 注入，生产由部署配置注入。",
    );
    process.exit(1);
  }
  return value;
}

/** 执行迁移；返回值即进程退出码——0 只代表本次 `migrate()` 正常返回。 */
async function runMigration(databaseUrl: string): Promise<number> {
  let pool: Pool | undefined;
  let lockClient: Client | undefined;
  let lockHeld = false;

  try {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    lockClient = new Client({ connectionString: databaseUrl });
    // 锁连接与迁移连接分开：`pg_advisory_lock` 是会话级锁，必须由一个存活的会话持有，
    // 而 `migrate()` 自己从 pool 取连接。
    await lockClient.connect();
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
    lockHeld = true;

    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log("[migrate] DDL 迁移已全部应用。");
    return 0;
  } catch (err) {
    console.error(
      `[migrate] ${lockHeld ? "DDL 迁移" : "连接数据库或获取迁移锁"}失败：${describeError(err, databaseUrl)}`,
    );
    return 1;
  } finally {
    if (lockHeld && lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_KEY]);
      } catch (err) {
        // 解锁失败不改变迁移结果：会话结束同样会释放 advisory lock（进程即将退出）。
        console.error(`[migrate] 释放迁移锁失败（随会话结束释放）：${describeError(err, databaseUrl)}`);
      }
    }
    if (lockClient) {
      await lockClient.end().catch((err: unknown) => {
        console.error(`[migrate] 关闭迁移锁连接失败：${describeError(err, databaseUrl)}`);
      });
    }
    if (pool) {
      await pool.end().catch((err: unknown) => {
        console.error(`[migrate] 关闭连接池失败：${describeError(err, databaseUrl)}`);
      });
    }
  }
}

if (import.meta.main) {
  // 导入本模块不触发迁移：测试要导入 `maskDatabaseUrlSecrets`，而顶层直跑会连库并改 `process.exitCode`。
  process.exitCode = await runMigration(readDatabaseUrl());
}
