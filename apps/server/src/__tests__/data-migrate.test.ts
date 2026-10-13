import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { migrateAgentConfigModelId } from "@fenix/agent-config/db/migration";
import type { DataMigration, DataMigrationDeclaration, ModuleManifest } from "@fenix/platform-sdk";
import { migrateSkillStorageByOrganization } from "@fenix/resource-skill/db/migration";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { _deps, _resetDeps, resolveDataMigrations, runDataMigrations } from "../services/data-migrate";

/** 构造测试用迁移：契约的六个字段全部必填，用例只覆盖本场景关心的那几个。 */
function fakeMigration(spec: Pick<DataMigration, "name"> & Partial<DataMigration>): DataMigration {
  return {
    name: spec.name,
    dependsOn: spec.dependsOn ?? [],
    metadata: spec.metadata ?? { expectedRows: "1 行", lockRisk: "none", observableFields: ["rows"] },
    run: spec.run ?? (async () => undefined),
    verify: spec.verify ?? (async () => undefined),
    compensation: spec.compensation ?? { kind: "none", reason: "测试替身无副作用可补偿" },
  };
}

/** 只带数据迁移声明的模块 manifest：registry 的其它字段与清单汇总无关，测试不复制它们。 */
function createManifest(id: string, dataMigrations: readonly DataMigrationDeclaration[]): ModuleManifest {
  return { id, kind: "resource", dependsOn: [], dataMigrations };
}

/** 声明一条指向给定实现的迁移事实；`overrides` 用于构造声明与实现漂移的场景。 */
function declareMigration(
  migration: DataMigration,
  overrides: Partial<DataMigrationDeclaration> = {},
): DataMigrationDeclaration {
  return { name: migration.name, dependsOn: [...migration.dependsOn], load: async () => migration, ...overrides };
}

/** 元信息、依赖诊断与补偿结果都只经日志暴露，因此相关断言必须落在文本上。 */
function collectLogs(): string[] {
  const lines: string[] = [];
  _deps.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  _deps.warn = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  return lines;
}

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
    const migrateA = fakeMigration({
      name: "migrate-a",
      run: mock(async () => {
        executed.push("migrate-a");
      }),
    });
    const migrateB = fakeMigration({
      name: "migrate-b",
      run: mock(async () => {
        executed.push("migrate-b");
      }),
    });
    const insertRecord = mock(async (name: string) => {
      executed.push(`record:${name}`);
    });

    _deps.listAppliedMigrationNames = async () => ["migrate-a"];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = () => {};

    await runDataMigrations([migrateA, migrateB]);

    expect(executed).toEqual(["migrate-b", "record:migrate-b"]);
    expect(insertRecord).toHaveBeenCalledTimes(1);
  });

  // 任意 migrate 失败都应阻断后续执行，且不写入成功记录。
  test("throws when migration fails", async () => {
    const succeeding = fakeMigration({ name: "migrate-a", run: mock(async () => undefined) });
    const failing = fakeMigration({
      name: "migrate-b",
      run: mock(async () => {
        throw new Error("boom");
      }),
    });
    const insertRecord = mock(async () => undefined);

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = () => {};

    await expect(runDataMigrations([succeeding, failing])).rejects.toThrow("boom");
    expect(insertRecord).toHaveBeenCalledTimes(1);
    const insertCalls = insertRecord.mock.calls as unknown as Array<[string]>;
    expect(insertCalls[0]?.[0]).toBe("migrate-a");
  });

  // 依赖不在清单内时按失败处理（不静默跳过），诊断要指出「ID 可能被改名」这条待人工核对的线索。
  test("fails when a declared dependency is outside the scheduled list", async () => {
    const run = mock(async () => undefined);
    const dependent = fakeMigration({ name: "migrate-b", dependsOn: ["migrate-a"], run });
    const insertRecord = mock(async () => undefined);

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = () => {};

    // 诊断必须带上「ID 可能被改名」这条待人工核对的线索，否则只剩一句「依赖未完成」无从下手。
    await expect(runDataMigrations([dependent])).rejects.toThrow(
      "迁移 'migrate-b' 的依赖未完成：migrate-a。其中 migrate-a 不在本次部署的清单内",
    );
    expect(run).not.toHaveBeenCalled();
    expect(insertRecord).not.toHaveBeenCalled();
  });

  // 依赖在清单内但排在后面同样是未完成：清单顺序不兜底依赖，否则重排数组会静默改变迁移语义。
  test("fails when a declared dependency is scheduled later in the same run", async () => {
    const dependent = fakeMigration({ name: "migrate-b", dependsOn: ["migrate-a"] });

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = mock(async () => undefined);
    _deps.log = () => {};

    await expect(runDataMigrations([dependent, fakeMigration({ name: "migrate-a" })])).rejects.toThrow(
      "本次部署清单含这些迁移但它们尚未落库",
    );
  });

  // 依赖在本轮先完成时后续迁移正常执行：依赖判定要认本轮刚写入的完成记录。
  test("runs a migration whose dependency completed in the same run", async () => {
    const executed: string[] = [];

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = async (name) => {
      executed.push(`record:${name}`);
    };
    _deps.log = () => {};

    await runDataMigrations([
      fakeMigration({
        name: "migrate-a",
        run: async () => {
          executed.push("migrate-a");
        },
      }),
      fakeMigration({
        name: "migrate-b",
        dependsOn: ["migrate-a"],
        run: async () => {
          executed.push("migrate-b");
        },
      }),
    ]);

    expect(executed).toEqual(["migrate-a", "record:migrate-a", "migrate-b", "record:migrate-b"]);
  });

  // 元信息必须在 run 之前输出：发布方要能在迁移动到数据之前看到预期影响面与可观测字段。
  test("logs static metadata before running a migration", async () => {
    const order: string[] = [];
    const migrate = fakeMigration({
      name: "migrate-a",
      dependsOn: ["migrate-x"],
      metadata: { expectedRows: "约 500 行", lockRisk: "row-level", observableFields: ["rows", "resourceType"] },
      run: async () => {
        order.push("run");
      },
    });

    _deps.listAppliedMigrationNames = async () => ["migrate-x"];
    _deps.insertDataMigrateRecord = async () => {
      order.push("record");
    };
    const logs = collectLogs();

    await runDataMigrations([migrate]);

    expect(logs.join("\n")).toContain("预期数据量=约 500 行；锁风险=row-level；可观测字段=[rows, resourceType]");
    expect(order).toEqual(["run", "record"]);
  });

  // verify 失败等同于迁移未完成：不写完成记录、执行补偿并抛出校验错误。
  test("skips the completion record and compensates when verify fails", async () => {
    const compensations: string[] = [];
    const migrate = fakeMigration({
      name: "migrate-a",
      run: mock(async () => undefined),
      verify: async () => {
        throw new Error("结果不完整");
      },
      compensation: {
        kind: "handler",
        run: async () => {
          compensations.push("migrate-a");
        },
      },
    });
    const insertRecord = mock(async () => undefined);

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = insertRecord;
    _deps.log = () => {};

    await expect(runDataMigrations([migrate])).rejects.toThrow("结果不完整");
    expect(migrate.run).toHaveBeenCalledTimes(1);
    expect(compensations).toEqual(["migrate-a"]);
    expect(insertRecord).not.toHaveBeenCalled();
  });

  // 校验失败不留完成记录，因此重跑会重新执行 run；通过后只落一次记录，无需人工清理即可收敛。
  test("reruns after a failed verification and records completion once", async () => {
    let verifyAttempts = 0;
    const runs: string[] = [];
    const records: string[] = [];
    const migrate = fakeMigration({
      name: "migrate-a",
      run: async () => {
        runs.push("run");
      },
      verify: async () => {
        verifyAttempts += 1;
        if (verifyAttempts === 1) throw new Error("首次校验未通过");
      },
    });

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = async (name) => {
      records.push(name);
    };
    _deps.log = () => {};

    await expect(runDataMigrations([migrate])).rejects.toThrow("首次校验未通过");
    await runDataMigrations([migrate]);

    expect(runs).toEqual(["run", "run"]);
    expect(records).toEqual(["migrate-a"]);
  });

  // 补偿失败不得掩盖原始错误：抛出的仍是 run 的错误，两条诊断同时留在日志里。
  test("keeps the original error when compensation fails", async () => {
    const migrate = fakeMigration({
      name: "migrate-a",
      run: async () => {
        throw new Error("原始故障");
      },
      compensation: {
        kind: "handler",
        run: async () => {
          throw new Error("补偿故障");
        },
      },
    });

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = mock(async () => undefined);
    const logs = collectLogs();

    await expect(runDataMigrations([migrate])).rejects.toThrow("原始故障");
    const diagnosis = logs.join("\n");
    expect(diagnosis).toContain("补偿失败：Error: 补偿故障");
    expect(diagnosis).toContain("原始错误：Error: 原始故障");
  });

  // 无可补偿的迁移必须显式声明：失败时不执行任何补偿，并在日志里说明靠什么收敛到完成态。
  test("reports explicitly declared missing compensation", async () => {
    const migrate = fakeMigration({
      name: "migrate-a",
      run: async () => {
        throw new Error("boom");
      },
      compensation: { kind: "none", reason: "旧值已不保留副本，靠重跑收敛" },
    });

    _deps.listAppliedMigrationNames = async () => [];
    _deps.insertDataMigrateRecord = mock(async () => undefined);
    const logs = collectLogs();

    await expect(runDataMigrations([migrate])).rejects.toThrow("boom");
    expect(logs.join("\n")).toContain("未执行补偿（声明无可补偿：旧值已不保留副本，靠重跑收敛）");
  });
});

describe("data migrate assembly aggregation", () => {
  // 清单按装配汇总：模块声明的事实经 load() 装载成实现，宿主自有迁移一并入清单且排在模块之后。
  test("collects module declarations and the host-owned migration", async () => {
    const moduleMigration = fakeMigration({ name: "migrate-a", dependsOn: ["migrate-x"] });
    const laterModuleMigration = fakeMigration({ name: "migrate-b" });

    const migrations = await resolveDataMigrations([
      createManifest("agent-config", [declareMigration(moduleMigration), declareMigration(laterModuleMigration)]),
      createManifest("skill", []),
    ]);

    expect(migrations.map((migration) => migration.name)).toEqual([
      "migrate-a",
      "migrate-b",
      "access-control/20260919-backfill-resource-visibility",
    ]);
    // 装载出的必须是声明指向的那个实现对象：元信息与 run/verify/compensation 都随它走。
    expect(migrations[0]).toBe(moduleMigration);
    expect(migrations[1]).toBe(laterModuleMigration);
  });

  // 声明与实现的 ID 不一致必须在执行前失败：ID 是 data_migrate_record 的幂等判据，两处分歧会让日志与记录各说一套。
  test("rejects a declaration whose name diverges from the implementation", async () => {
    const migration = fakeMigration({ name: "migrate-renamed" });

    await expect(
      resolveDataMigrations([createManifest("agent-config", [declareMigration(migration, { name: "migrate-a" })])]),
    ).rejects.toThrow("声明的迁移 ID 'migrate-a' 与实现的 'migrate-renamed' 不一致");
  });

  // 依赖分歧同样按失败处理：dependsOn 决定执行前的顺序判据，两个版本会让同一份依赖图出现两种解释。
  test("rejects a declaration whose dependency set diverges from the implementation", async () => {
    const migration = fakeMigration({ name: "migrate-a", dependsOn: ["migrate-x"] });

    await expect(
      resolveDataMigrations([createManifest("agent-config", [declareMigration(migration, { dependsOn: [] })])]),
    ).rejects.toThrow("依赖不一致：声明=[]，实现=[migrate-x]");
  });

  // 装载失败要带上模块 ID 与迁移 ID：裸的 dynamic import 报错只剩「Cannot find module」，发布方无从定位。
  test("reports module and migration when loading an implementation fails", async () => {
    const declaration: DataMigrationDeclaration = {
      name: "migrate-a",
      dependsOn: [],
      load: async () => {
        throw new Error("Cannot find module");
      },
    };

    await expect(resolveDataMigrations([createManifest("agent-config", [declaration])])).rejects.toThrow(
      "模块 agent-config 声明的迁移 'migrate-a' 装载失败",
    );
  });

  // 迁移 ID 全局唯一：同 ID 出现两次会让同一次发布重复执行同一迁移并各写一条记录。
  test("rejects duplicate migration IDs across the assembled list", async () => {
    const migration = fakeMigration({ name: "migrate-a" });
    const duplicate = fakeMigration({ name: "migrate-a" });

    await expect(
      resolveDataMigrations([
        createManifest("agent-config", [declareMigration(migration)]),
        createManifest("skill", [declareMigration(duplicate)]),
      ]),
    ).rejects.toThrow("迁移 ID 重复: migrate-a");
  });

  // 真实装配清单必须仍含已落库的两个 ID（改名会被判为未应用而重跑）与宿主自有回填，且装载出的就是
  // owner 包导出的那份实现——清单来源从人肉数组换成装配汇总，不得换掉或改序任何一条迁移。
  test("keeps the applied migration IDs and the host-owned migration", async () => {
    const migrations = await resolveDataMigrations(generatedModuleManifests);

    expect(migrations.map((migration) => migration.name)).toEqual([
      "migrate-agent-config-model-id",
      "migrate-skill-storage-by-organization",
      "access-control/20260919-backfill-resource-visibility",
    ]);
    // 装载出的是 owner 包导出的那份实现对象本身：`metadata` / `run` / `verify` / `compensation` 都随实现走，
    // 汇总方式变更不得顺带改掉任何一条迁移的行为。
    expect(migrations[0]).toBe(migrateAgentConfigModelId);
    expect(migrations[1]).toBe(migrateSkillStorageByOrganization);
  });
});
