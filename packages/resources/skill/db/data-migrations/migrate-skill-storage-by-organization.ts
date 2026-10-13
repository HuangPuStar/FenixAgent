/**
 * 把旧布局 `data/skills/<name>` 的 skill 目录分发到按组织隔离的 `data/skills/<orgId>/<name>`
 * （§6.3 数据迁移按模块归属维护）。
 *
 * 为什么归 skill：迁移的对象是本包 owner 的 skill 内容与资源行，按 §6.3「迁移代码归发起变更的模块」
 * 随 schema 一起搬进本包；文件放 `db/data-migrations/` 而不是 `src/server/services/`，与
 * `db/schema.ts` 同级——迁移依赖的字段、历史状态与文件布局都是本包的领域事实，放在 owner 包的
 * `db/**` 才不会被 `src/**` 的调用期禁则与模块装配顺序牵连（§6.1 第 2 条：`db/**` 不参与模块装配）。
 *
 * 取数与文件能力仍经本包的受限入口（`src/server/repositories` 的行投影、`src/server/services` 的
 * 归档/目录编排），不在迁移里直接写表：这条边是包内相对导入，§6.1 的跨包禁则不适用。
 */
import { cpSync, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DataMigration } from "@fenix/platform-sdk";
import { listAllSkillOrgAndNameUnscoped } from "../../src/server/repositories/skill";
import { getGlobalSkillsDir } from "../../src/server/services/skill-content";
import { buildSkillArchive, getSkillArchivePath, getSkillSourceDir } from "../../src/server/services/skill-fs";

/** 待迁移行的投影：只取分发到哪个组织目录、用哪个名字，其余列不进入迁移的判定。 */
export interface SkillStorageMigrationRow {
  organizationId: string;
  name: string;
}

export const _deps = {
  // 行投影由仓储给出：本包对 `skill` 表的查询只允许出现在 repositories/ 下。
  listSkills: async (): Promise<readonly SkillStorageMigrationRow[]> => listAllSkillOrgAndNameUnscoped(),
  getSkillRoot: (): string => getGlobalSkillsDir(),
  buildSkillArchive,
};

export function _resetDeps() {
  _deps.listSkills = async () => listAllSkillOrgAndNameUnscoped();
  _deps.getSkillRoot = () => getGlobalSkillsDir();
  _deps.buildSkillArchive = buildSkillArchive;
}

/** 启动迁移：把旧 data/skills/<name> 迁移到 data/skills/<orgId>/<name>。 */
export const migrateSkillStorageByOrganization: DataMigration = {
  name: "migrate-skill-storage-by-organization",
  // 只按 skill 表已有的组织和名字分发文件，不依赖任何其他数据迁移的写入结果。
  dependsOn: [],
  metadata: {
    expectedRows:
      "与历史 skill 种类数同阶（按 `data/skills/<name>` 遗留目录计，无遗留目录的库为 0）；只写文件系统，不产生 DB 写入",
    lockRisk: "none",
    observableFields: ["name", "org"],
  },
  async run(context) {
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
            context.warn(
              `[data-migrate] skill storage skip existing target name='${row.name}' org='${row.organizationId}'`,
            );
            continue;
          }

          await mkdir(dirname(targetDir), { recursive: true });
          cpSync(legacyDir, targetDir, { recursive: true });
          await _deps.buildSkillArchive(targetDir, targetArchivePath);
          createdTargets.push({ targetDir, targetArchivePath });
          context.log(`[data-migrate] migrated skill storage name='${row.name}' org='${row.organizationId}'`);
        }

        // 只有所有目标都是本次从旧目录成功分发出来的，才安全删除旧目录。
        if (!hasExistingTarget) {
          await rm(legacyDir, { recursive: true, force: true });
          await rm(legacyArchivePath, { force: true });
        }
      } catch (error) {
        // 这是**单次 run 内**的现场回收，不是契约里的 compensation：本次新建的目标只可能是半成品，清掉才能让
        // 重跑把它当成「尚未迁移」重新分发。整个迁移的补偿另见下方 compensation 的判定。
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
  async verify() {
    const rows = await _deps.listSkills();
    const skillRoot = _deps.getSkillRoot();
    const unresolved: string[] = [];
    for (const row of rows) {
      // 旧目录已被删除的行无需求证：run 只在每个目标都已就位（新建或本来就存在）时才删除旧目录。
      if (!existsSync(join(skillRoot, row.name))) continue;
      if (!existsSync(getSkillSourceDir(skillRoot, row.organizationId, row.name))) {
        unresolved.push(`${row.organizationId}/${row.name}`);
      }
    }
    if (unresolved.length > 0) {
      // 旧目录还在但组织目录缺失，只可能来自「跳过目标」这条保守分支之后的目录丢失；
      // 此时文件仍以旧布局可达，但新代码只读组织目录，必须人工确认后再决定是补分发还是回退。
      throw new Error(
        `[data-migrate] 仍有 ${unresolved.length} 个 skill 的遗留目录存在但组织目录缺失（如 '${unresolved[0]}'），` +
          "文件仍以旧布局可达而新代码只读组织目录，需人工确认后补分发",
      );
    }
  },
  compensation: {
    kind: "none",
    // run 删除旧目录时不保留第二份副本：补偿「删掉已分发的组织目录」等于销毁唯一副本，比失败本身更糟。
    // 已完成分发的 skill 是终态（重跑按 existsSync(targetDir) 跳过），失败后重跑即可继续处理剩余 skill。
    reason: "旧目录删除后不留第二份副本，回滚会销毁 skill 内容的唯一副本；靠幂等重跑收敛",
  },
};
