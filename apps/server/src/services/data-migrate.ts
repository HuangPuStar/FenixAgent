import { log } from "@fenix/logger";
import { migrateSkillStorageByOrganization } from "@fenix/resource-skill/server/migration";
import { db } from "../db";
import { dataMigrateRecord } from "../db/schema";
import { migrateBackfillResourceVisibility } from "./data-migrates/backfill-resource-visibility";
import { migrateAgentConfigModelId } from "./data-migrates/migrate-agent-config-model-id";

/** 一次性的业务数据迁移：`name` 是 `data_migrate_record` 里的全局唯一 ID，也是幂等跳过的判据。 */
export interface DataMigrate {
  name: string;
  run: () => Promise<void>;
}

export const _deps = {
  migrates: [
    migrateAgentConfigModelId,
    migrateSkillStorageByOrganization,
    migrateBackfillResourceVisibility,
  ] as DataMigrate[],
  listAppliedMigrationNames: async (): Promise<string[]> => {
    const rows = await db.select({ name: dataMigrateRecord.name }).from(dataMigrateRecord);
    return rows.map((row) => row.name);
  },
  insertDataMigrateRecord: async (name: string): Promise<void> => {
    await db.insert(dataMigrateRecord).values({ name });
  },
  log,
};

export function _resetDeps() {
  _deps.migrates = [migrateAgentConfigModelId, migrateSkillStorageByOrganization, migrateBackfillResourceVisibility];
  _deps.listAppliedMigrationNames = async () => {
    const rows = await db.select({ name: dataMigrateRecord.name }).from(dataMigrateRecord);
    return rows.map((row) => row.name);
  };
  _deps.insertDataMigrateRecord = async (name: string) => {
    await db.insert(dataMigrateRecord).values({ name });
  };
  _deps.log = log;
}

/**
 * 按注册表声明顺序执行尚未落库记录的数据迁移（已应用项按 `data_migrate_record` 跳过）。
 *
 * 调用方是部署期入口 `db/data-migration-runner.ts`，**不再**是宿主启动序：§6.3 与 §10.6.2 要求一次性
 * 数据迁移只由部署发布任务执行，每个应用副本启动时各跑一次含文件副作用的迁移不是幂等并发安全
 * （见 `docs/need-to-change/31-gate-release-and-migration.md`）。
 *
 * 注册表数组顺序即依赖顺序（`_deps.migrates` 只追加，不重排）。§6.3 的迁移级 `dependsOn` 声明与拓扑
 * 排序尚未实现——现有三个迁移之间没有数据依赖，等出现真实跨模块依赖时再引入。
 */
export async function runDataMigrations(): Promise<void> {
  const applied = new Set(await _deps.listAppliedMigrationNames());
  for (const migrate of _deps.migrates) {
    if (applied.has(migrate.name)) {
      _deps.log(`[data-migrate] skip applied migrate '${migrate.name}'`);
      continue;
    }
    _deps.log(`[data-migrate] run migrate '${migrate.name}'`);
    await migrate.run();
    await _deps.insertDataMigrateRecord(migrate.name);
    _deps.log(`[data-migrate] finished migrate '${migrate.name}'`);
  }
}
