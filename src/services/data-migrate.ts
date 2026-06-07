import { log } from "@fenix/logger";
import { db } from "../db";
import { dataMigrateRecord } from "../db/schema";
import { migrateSkillStorageByOrganization } from "./data-migrates/migrate-skill-storage-by-organization";

export interface DataMigrate {
  name: string;
  run: () => Promise<void>;
}

export const _deps = {
  migrates: [migrateSkillStorageByOrganization] as DataMigrate[],
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
  _deps.migrates = [migrateSkillStorageByOrganization];
  _deps.listAppliedMigrationNames = async () => {
    const rows = await db.select({ name: dataMigrateRecord.name }).from(dataMigrateRecord);
    return rows.map((row) => row.name);
  };
  _deps.insertDataMigrateRecord = async (name: string) => {
    await db.insert(dataMigrateRecord).values({ name });
  };
  _deps.log = log;
}

/** 启动后按顺序执行尚未落库记录的数据迁移。 */
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
