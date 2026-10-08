import { log, warn } from "@fenix/logger";
import type {
  DataMigration,
  DataMigrationContext,
  DataMigrationDeclaration,
  ModuleManifest,
} from "@fenix/platform-sdk";
import { db } from "../db";
import { dataMigrateRecord } from "../db/schema";
import { migrateBackfillResourceVisibility } from "./data-migrates/backfill-resource-visibility";

/**
 * 宿主侧的迁移清单汇总与执行器：按装配汇总清单后，执行尚未落库的数据迁移。
 *
 * 契约（`name` / `dependsOn` / `metadata` / `run(context)` / `verify(context)` / `compensation`）定义在
 * `@fenix/platform-sdk` 的 `migration/data-migration`：迁移代码属于资源包，包不得导入应用内部路径，契约
 * 只能放在平台侧。本文件只做编排——清单汇总、依赖校验、元信息输出、失败补偿与完成记录归属，不含任何
 * 迁移业务逻辑。
 */
/**
 * 宿主自有迁移：没有 owner 包能合法持有它们，因此不进任何模块的 manifest 清单，只在这里登记一次。
 *
 * 当前唯一一条是四资源 visibility 回填——它跨 4 个 owner 读主表、又只能读宿主持有的旧授权表
 * `resource_permission`，没有任何一个包能同时满足两条约束，理由见该文件头部（含「不拆成四条包内迁移」
 * 的发布契约理由）。它随 `resource_permission` DROP 一并删除。
 */
const HOST_MIGRATIONS: readonly DataMigration[] = [migrateBackfillResourceVisibility];

/**
 * 按装配汇总迁移清单：已装配模块在 manifest 里声明的事实 + {@link HOST_MIGRATIONS}。
 *
 * 清单来自**构建期收集的可信模块集合**，不按 profile 收窄：DDL 链是全仓共享的，迁移要触碰的表在每个
 * profile 下都存在；而 data-migrate 镜像只带一个自包含的 bundle（`Dockerfile` 的 data-migrate 阶段不复制
 * `deploy/assembly`），在那里解析 profile 必然 ENOENT，把清单绑到 profile 会让发布步骤在一种受支持的运行
 * 形态下直接失败。模块是否启用因此不是「这条迁移该不该跑」的判据，ID 落库与否才是。
 *
 * 清单顺序只决定日志顺序，依赖一律由各迁移的 `dependsOn` 表达；先模块后宿主，与历史注册表的顺序一致。
 */
export async function resolveDataMigrations(modules: readonly ModuleManifest[]): Promise<readonly DataMigration[]> {
  const declared = modules.flatMap((manifest) =>
    (manifest.dataMigrations ?? []).map((declaration) => ({ declaration, moduleId: manifest.id })),
  );

  const loaded = await Promise.all(
    declared.map(async ({ declaration, moduleId }) => {
      const migration = await loadDeclaration(declaration, moduleId);
      assertDeclarationMatchesImplementation(declaration, migration, moduleId);
      return migration;
    }),
  );

  const migrations = [...loaded, ...HOST_MIGRATIONS];
  assertUniqueMigrationNames(migrations);
  return migrations;
}

/**
 * 装载声明指向的实现。
 *
 * 包裹一层只为把模块 ID 与迁移 ID 带进诊断：裸的 dynamic import 失败只剩「Cannot find module」，发布方
 * 无从判断是哪个模块的哪条迁移。`cause` 原样保留——入口的 `describeError` 会展开它，根因不丢。
 */
async function loadDeclaration(declaration: DataMigrationDeclaration, moduleId: string): Promise<DataMigration> {
  try {
    return await declaration.load();
  } catch (error) {
    throw new Error(
      `[data-migrate] 模块 ${moduleId} 声明的迁移 '${declaration.name}' 装载失败：实现入口不可达或模块求值抛错`,
      { cause: error },
    );
  }
}

/**
 * 校验装配声明与实现逐字一致。
 *
 * 声明与实现是同一事实的两处写法，分歧必须在这里失败而不是留到运行期：`name` 参与了幂等判据
 * （`data_migrate_record`），实现侧改名会被判为未应用而重跑，声明侧改名则会让日志与记录各说一套；
 * `dependsOn` 决定执行前校验的顺序判据，分歧会让同一份依赖图出现两个版本。`dependsOn` 按集合比较——
 * 它的顺序不承载语义（各迁移自己的注释已写明），不因重排而失败。
 */
function assertDeclarationMatchesImplementation(
  declaration: DataMigrationDeclaration,
  migration: DataMigration,
  moduleId: string,
): void {
  if (migration.name !== declaration.name) {
    throw new Error(
      `[data-migrate] 模块 ${moduleId} 声明的迁移 ID '${declaration.name}' 与实现的 '${migration.name}' 不一致；` +
        "迁移 ID 已落 data_migrate_record（发布契约），两处必须逐字相同。",
    );
  }

  const declared = [...declaration.dependsOn].sort();
  const implemented = [...migration.dependsOn].sort();
  const sameSet =
    declared.length === implemented.length && declared.every((name, index) => name === implemented[index]);
  if (!sameSet) {
    throw new Error(
      `[data-migrate] 模块 ${moduleId} 声明的迁移 '${declaration.name}' 依赖不一致：` +
        `声明=[${declared.join(", ")}]，实现=[${implemented.join(", ")}]。`,
    );
  }
}

/**
 * 迁移 ID 必须全局唯一（§6.3）。
 *
 * `data_migrate_record` 是按 ID 判幂等的全局表，同 ID 出现两次会让同一次发布重复执行同一迁移并各写一条
 * 记录——两次 run 之间的间歇足以让「幂等」假设失效（文件副作用尤其如此）。判定放在这里而不是各模块内：
 * 只有汇总方能同时看到模块声明与宿主自有迁移，两条路径撞车的可能性也正是在这里才会显形。
 */
function assertUniqueMigrationNames(migrations: readonly DataMigration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.name)) {
      throw new Error(`[data-migrate] 迁移 ID 重复: ${migration.name}；迁移 ID 是全局唯一的发布契约`);
    }
    seen.add(migration.name);
  }
}

export const _deps = {
  listAppliedMigrationNames: async (): Promise<string[]> => {
    const rows = await db.select({ name: dataMigrateRecord.name }).from(dataMigrateRecord);
    return rows.map((row) => row.name);
  },
  insertDataMigrateRecord: async (name: string): Promise<void> => {
    await db.insert(dataMigrateRecord).values({ name });
  },
  log,
  warn,
};

export function _resetDeps() {
  _deps.listAppliedMigrationNames = async () => {
    const rows = await db.select({ name: dataMigrateRecord.name }).from(dataMigrateRecord);
    return rows.map((row) => row.name);
  };
  _deps.insertDataMigrateRecord = async (name: string) => {
    await db.insert(dataMigrateRecord).values({ name });
  };
  _deps.log = log;
  _deps.warn = warn;
}

/**
 * 迁移执行上下文：把宿主的日志通道交给迁移，使迁移不直接依赖具体的日志实现（§7 的日志汇聚口径属于调用方）。
 *
 * 取值走 lambda 而不是直接引用 `_deps.log`：测试通过替换 `_deps.log` 注入日志替身，直接引用会把
 * 注入前的那份函数固定进上下文。
 */
function createMigrationContext(): DataMigrationContext {
  return {
    log: (message) => _deps.log(message),
    warn: (message) => _deps.warn(message),
  };
}

/** 单行错误摘要：`cause` 链由入口 `describeError` 展开，这里只取 message，避免多行栈挤进一行日志。 */
function describeFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 执行前校验依赖已完成。
 *
 * 依赖缺失一律按失败处理，不静默跳过：跳过会让「后续迁移已执行、依赖却从未完成」这个状态被写进
 * `data_migrate_record`，而记录一旦落库就无法靠重试自愈。诊断要把缺失 ID 分成两类——清单内未完成
 * （发布顺序问题，补跑即可）与清单外（ID 被改名或移除，需要人工核对），两者的处置方式完全不同。
 */
function assertDependenciesCompleted(
  migrate: DataMigration,
  satisfied: ReadonlySet<string>,
  scheduledNames: ReadonlySet<string>,
): void {
  const missing = migrate.dependsOn.filter((name) => !satisfied.has(name));
  if (missing.length === 0) return;

  const unknown = missing.filter((name) => !scheduledNames.has(name));
  throw new Error(
    `[data-migrate] 迁移 '${migrate.name}' 的依赖未完成：${missing.join(", ")}。` +
      (unknown.length > 0
        ? `其中 ${unknown.join(", ")} 不在本次部署的清单内，可能已被改名或移除；` +
          "迁移 ID 是发布契约，改名会被判为未应用，请先核对 ID 并补跑对应迁移。"
        : "本次部署清单含这些迁移但它们尚未落库，可能是执行失败；请先补跑依赖迁移再重新发布。"),
  );
}

/** 执行前输出静态元信息：预期数据量、锁风险与可观测字段，供发布方在迁移动到数据之前对照。 */
function logMigrationMetadata(migrate: DataMigration): void {
  const { expectedRows, lockRisk, observableFields } = migrate.metadata;
  _deps.log(
    `[data-migrate] migrate '${migrate.name}' 元信息：依赖=[${migrate.dependsOn.join(", ")}]；` +
      `预期数据量=${expectedRows}；锁风险=${lockRisk}；可观测字段=[${observableFields.join(", ")}]`,
  );
}

/**
 * 执行失败补偿，并保证原始错误不被补偿本身的失败掩盖。
 *
 * 补偿失败只记录、不抛出：待补偿的调用方即将重新抛出**原始错误**——它才是发布失败的根因，被补偿错误顶掉
 * 会让人去查一个二级故障。两条诊断写在同一条日志里，既保留根因又暴露补偿需要人工介入。
 */
async function runCompensation(
  migrate: DataMigration,
  context: DataMigrationContext,
  original: unknown,
): Promise<void> {
  if (migrate.compensation.kind === "none") {
    _deps.log(`[data-migrate] migrate '${migrate.name}' 未执行补偿（声明无可补偿：${migrate.compensation.reason}）`);
    return;
  }

  try {
    await migrate.compensation.run(context);
    _deps.log(`[data-migrate] migrate '${migrate.name}' 补偿已完成`);
  } catch (compensationError) {
    _deps.log(
      `[data-migrate] migrate '${migrate.name}' 补偿失败：${describeFailure(compensationError)}；` +
        `原始错误：${describeFailure(original)}`,
    );
  }
}

/**
 * 执行尚未落库记录的数据迁移（已应用项按 `data_migrate_record` 跳过）。清单由
 * {@link resolveDataMigrations} 按装配汇总出来，本函数只按清单给出的顺序执行。
 *
 * 调用方是部署期入口 `db/data-migration-runner.ts`，**不再**是宿主启动序：§6.3 与 §10.6.2 要求一次性
 * 数据迁移只由部署发布任务执行，每个应用副本启动时各跑一次含文件副作用的迁移不是幂等并发安全
 * （部署期执行口径见 `docs/operations/migration.md`）。
 *
 * 清单顺序只是**便于阅读**的声明顺序，依赖由每个迁移的 `dependsOn` 表达并在执行前校验；不依赖数组
 * 顺序隐式承载依赖，否则重排清单就会静默改变迁移语义。
 *
 * 单个迁移的执行序列是「校验依赖 → 输出元信息 → run → verify → 写完成记录」，run 或 verify 失败即补偿并
 * fail-stop（后续迁移不执行、不写记录）。verify 失败与 run 失败同等对待：记录只在「结果已验证完整」之后
 * 才落库，否则重跑会被跳过而半迁移状态永久留存。
 */
export async function runDataMigrations(migrations: readonly DataMigration[]): Promise<void> {
  const satisfied = new Set(await _deps.listAppliedMigrationNames());
  // 依赖诊断要区分「清单内未完成」与「清单外（可能已改名）」，因此先固化本次清单的 ID 集合。
  const scheduledNames = new Set(migrations.map((migrate) => migrate.name));

  for (const migrate of migrations) {
    if (satisfied.has(migrate.name)) {
      _deps.log(`[data-migrate] skip applied migrate '${migrate.name}'`);
      continue;
    }

    assertDependenciesCompleted(migrate, satisfied, scheduledNames);
    logMigrationMetadata(migrate);

    const context = createMigrationContext();
    _deps.log(`[data-migrate] run migrate '${migrate.name}'`);
    try {
      await migrate.run(context);
      await migrate.verify(context);
    } catch (error) {
      await runCompensation(migrate, context, error);
      // 原样抛出：入口据此展开 cause 链并掩掉连接串口令，此处二次包装会丢掉 drizzle → pg 的根因。
      throw error;
    }

    // 完成记录写在补偿范围之外：此时数据已迁移并已验证完整，只因记录落库失败就撤销数据会制造新的不一致。
    // 记录缺失的表现是「下次发布重跑」，而幂等 run 会把重跑收敛成 no-op，代价远小于回滚已完成的数据。
    await _deps.insertDataMigrateRecord(migrate.name);
    satisfied.add(migrate.name);
    _deps.log(`[data-migrate] finished migrate '${migrate.name}'`);
  }
}
