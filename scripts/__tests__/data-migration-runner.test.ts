import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { _deps, _resetDeps, type DataMigrate, runDataMigrations } from "../../apps/server/src/services/data-migrate";
import { runDataMigrationEntrypoint } from "../../db/data-migration-runner";

const repoRoot = resolve(import.meta.dir, "../..");

/** 只保留被注入替身替换的那部分依赖，其余用静默替身，避免测试输出污染断言。 */
function createRunnerDeps(overrides: { closeDatabase: () => Promise<void>; onError?: (message: string) => void }) {
  return {
    runDataMigrations,
    closeDatabase: overrides.closeDatabase,
    log: () => {},
    logError: overrides.onError ?? (() => {}),
  };
}

describe("部署期数据迁移入口", () => {
  beforeEach(() => {
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
  });

  // 已应用项按 data_migrate_record 跳过，未应用项执行后写入完成记录，入口以 0 退出并关闭连接。
  test("skips applied migrations and exits 0", async () => {
    const executed: string[] = [];
    const applied: DataMigrate = {
      name: "migrate-a",
      run: mock(async () => {
        executed.push("migrate-a");
      }),
    };
    const pending: DataMigrate = {
      name: "migrate-b",
      run: mock(async () => {
        executed.push("migrate-b");
      }),
    };
    const insertRecord = mock(async (name: string) => {
      executed.push(`record:${name}`);
    });
    _deps.migrates = [applied, pending];
    _deps.listAppliedMigrationNames = async () => ["migrate-a"];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = mock(() => {});

    const code = await runDataMigrationEntrypoint(
      createRunnerDeps({
        closeDatabase: async () => {
          executed.push("close");
        },
      }),
    );

    expect(code).toBe(0);
    expect(executed).toEqual(["migrate-b", "record:migrate-b", "close"]);
    expect(insertRecord).toHaveBeenCalledTimes(1);
  });

  // 任一迁移失败即中止：后续迁移不执行、不写成功记录，入口以非 0 退出且仍关闭连接。
  test("stops at the first failure and exits non-zero", async () => {
    const executed: string[] = [];
    const failing: DataMigrate = {
      name: "migrate-a",
      run: mock(async () => {
        throw new Error("boom");
      }),
    };
    const later: DataMigrate = {
      name: "migrate-b",
      run: mock(async () => {
        executed.push("migrate-b");
      }),
    };
    const insertRecord = mock(async () => undefined);
    _deps.migrates = [failing, later];
    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = mock(() => {});

    const errors: string[] = [];
    const code = await runDataMigrationEntrypoint(
      createRunnerDeps({
        closeDatabase: async () => {
          executed.push("close");
        },
        onError: (message) => errors.push(message),
      }),
    );

    expect(code).toBe(1);
    expect(executed).toEqual(["close"]);
    expect(insertRecord).toHaveBeenCalledTimes(0);
    expect(errors.join("\n")).toContain("boom");
  });

  // 关闭连接失败不改变迁移结果：记录已落库，不能因连接未关就判失败并让发布任务重复执行。
  test("keeps the exit code when closing the database fails", async () => {
    _deps.migrates = [{ name: "migrate-a", run: mock(async () => undefined) }];
    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = mock(async () => undefined);
    _deps.log = mock(() => {});

    const errors: string[] = [];
    const code = await runDataMigrationEntrypoint(
      createRunnerDeps({
        closeDatabase: async () => {
          throw new Error("pool already ended");
        },
        onError: (message) => errors.push(message),
      }),
    );

    expect(code).toBe(0);
    expect(errors.join("\n")).toContain("pool already ended");
  });
});

// 应用启动不得隐式运行业务数据迁移（§6.3 / §10.6.2）：宿主启动序不是可注入依赖，故在源码层钉住
// 「启动序不再引用数据迁移」这一事实，并确认发布期入口存在——否则「从启动序移除」会退化成功能删除。
test("宿主启动序不再执行数据迁移，改由部署期入口承担", () => {
  const hostStartup = readFileSync(resolve(repoRoot, "apps/server/src/bootstrap/host-startup.ts"), "utf8");
  expect(hostStartup).not.toContain("runDataMigrations");
  expect(hostStartup).not.toMatch(/services\/data-migrate/);

  const deployEntry = readFileSync(resolve(repoRoot, "db/data-migration-runner.ts"), "utf8");
  expect(deployEntry).toContain("await resolved.runDataMigrations()");
});
