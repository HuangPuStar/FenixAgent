import { cpSync, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log, warn } from "@fenix/logger";
import { db } from "../../db";
import { skill } from "../../db/schema";
import { getGlobalSkillsDir } from "../skill";
import { buildSkillArchive, getSkillArchivePath, getSkillSourceDir } from "../skill-fs";

export interface SkillStorageMigrationRow {
  organizationId: string;
  name: string;
}

export const _deps = {
  listSkills: async (): Promise<SkillStorageMigrationRow[]> =>
    db
      .select({
        organizationId: skill.organizationId,
        name: skill.name,
      })
      .from(skill),
  getSkillRoot: (): string => getGlobalSkillsDir(),
  buildSkillArchive,
  log,
  warn,
};

export function _resetDeps() {
  _deps.listSkills = async () =>
    db
      .select({
        organizationId: skill.organizationId,
        name: skill.name,
      })
      .from(skill);
  _deps.getSkillRoot = () => getGlobalSkillsDir();
  _deps.buildSkillArchive = buildSkillArchive;
  _deps.log = log;
  _deps.warn = warn;
}

/** 启动迁移：把旧 data/skills/<name> 迁移到 data/skills/<orgId>/<name>。 */
export const migrateSkillStorageByOrganization = {
  name: "migrate-skill-storage-by-organization",
  async run(): Promise<void> {
    const rows = await _deps.listSkills();
    const skillRoot = _deps.getSkillRoot();
    const rowsBySkillName = new Map<string, SkillStorageMigrationRow[]>();

    for (const row of rows) {
      const current = rowsBySkillName.get(row.name) ?? [];
      current.push(row);
      rowsBySkillName.set(row.name, current);
    }

    for (const [skillName, skillRows] of rowsBySkillName) {
      const legacyDir = join(skillRoot, skillName);
      const legacyArchivePath = join(skillRoot, `${skillName}.zip`);

      if (!existsSync(legacyDir)) {
        continue;
      }

      const createdTargets: Array<{ targetDir: string; targetArchivePath: string }> = [];
      let hasExistingTarget = false;

      try {
        for (const row of skillRows) {
          const targetDir = getSkillSourceDir(skillRoot, row.organizationId, row.name);
          const targetArchivePath = getSkillArchivePath(skillRoot, row.organizationId, row.name);
          if (existsSync(targetDir)) {
            hasExistingTarget = true;
            _deps.warn(
              `[data-migrate] skill storage skip existing target name='${row.name}' org='${row.organizationId}'`,
            );
            continue;
          }

          await mkdir(dirname(targetDir), { recursive: true });
          cpSync(legacyDir, targetDir, { recursive: true });
          await _deps.buildSkillArchive(targetDir, targetArchivePath);
          createdTargets.push({ targetDir, targetArchivePath });
          _deps.log(`[data-migrate] migrated skill storage name='${row.name}' org='${row.organizationId}'`);
        }

        // 只有所有目标都是本次从旧目录成功分发出来的，才安全删除旧目录。
        if (!hasExistingTarget) {
          await rm(legacyDir, { recursive: true, force: true });
          await rm(legacyArchivePath, { force: true });
        }
      } catch (error) {
        // 迁移失败时回收本次新建的目录，避免下次启动把半成品误认为已迁移完成。
        await Promise.all(
          createdTargets.map(async ({ targetDir, targetArchivePath }) => {
            await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
            await rm(targetArchivePath, { force: true }).catch(() => undefined);
          }),
        );
        throw error;
      }
    }
  },
};
