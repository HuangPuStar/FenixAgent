import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _deps, _resetDeps, type DataMigrate, runDataMigrations } from "../services/data-migrate";

describe("data migrate runner", () => {
  beforeEach(() => {
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
  });

  // 已执行 migrate 应跳过，剩余 migrate 按声明顺序执行并写入记录。
  test("runs unapplied migrations in order", async () => {
    const executed: string[] = [];
    const migrateA: DataMigrate = {
      name: "migrate-a",
      run: mock(async () => {
        executed.push("migrate-a");
      }),
    };
    const migrateB: DataMigrate = {
      name: "migrate-b",
      run: mock(async () => {
        executed.push("migrate-b");
      }),
    };
    const insertRecord = mock(async (name: string) => {
      executed.push(`record:${name}`);
    });

    _deps.migrates = [migrateA, migrateB];
    _deps.listAppliedMigrationNames = async () => ["migrate-a"];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = mock(() => {});

    await runDataMigrations();

    expect(executed).toEqual(["migrate-b", "record:migrate-b"]);
    expect(insertRecord).toHaveBeenCalledTimes(1);
  });

  // 任意 migrate 失败都应阻断后续执行，且不写入成功记录。
  test("throws when migration fails", async () => {
    const succeeding: DataMigrate = { name: "migrate-a", run: mock(async () => undefined) };
    const failing: DataMigrate = {
      name: "migrate-b",
      run: mock(async () => {
        throw new Error("boom");
      }),
    };
    const insertRecord = mock(async () => undefined);

    _deps.migrates = [succeeding, failing];
    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = mock(() => {});

    await expect(runDataMigrations()).rejects.toThrow("boom");
    expect(insertRecord).toHaveBeenCalledTimes(1);
    const insertCalls = insertRecord.mock.calls as unknown as Array<[string]>;
    expect(insertCalls[0]?.[0]).toBe("migrate-a");
  });
});
