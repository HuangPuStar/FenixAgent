/**
 * 一次性数据迁移的跨包契约（权威依据：`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.3）。
 *
 * 迁移代码按模块就近维护（`<owner>/db/data-migrations/`），由仓库级 runner 静态汇总后统一执行；两者
 * 之间只有本文件这一份契约。放在 platform-sdk 而不是宿主 `apps/server/src/services/data-migrate.ts`：
 * 迁移属于资源包，包不得导入应用内部路径（§2.2），而「各包各留一份类型」会让 runner 与迁移在字段增减
 * 时静默漂移——契约里少一个字段、迁移里多一个字段都不会报错，正是 §6.4 要消除的缺口。
 *
 * 本文件只有契约与纯类型：不导入 Drizzle、不读环境变量、不建连接池，也不含任何迁移业务逻辑。迁移的
 * 读写手段（受限 repository / SQL adapter）由各模块自己决定，本契约不预设。
 */

/**
 * 迁移执行上下文：由 runner 注入，迁移不得自行构造。
 *
 * 迁移不直接依赖 `@fenix/logger` 或宿主的日志实现：发布任务的日志汇聚口径（文件、结构化字段、脱敏）
 * 属于调用方，只有经注入通道输出才能保证迁移日志与 runner 日志落在同一处（§7）。
 */
export interface DataMigrationContext {
  /** 迁移级日志：输出批次进度与 {@link DataMigrationMetadata.observableFields} 声明的字段。 */
  readonly log: (message: string) => void;
  /** 需要人工关注的告警（如「目标已存在，保守跳过」）；与 `log` 分开以保留发布日志的严重级别。 */
  readonly warn: (message: string) => void;
}

/**
 * 迁移写入对数据库锁的影响面。
 *
 * 与批量超时、背压不同，锁风险无法靠运行时参数消除，必须在写迁移时判定并声明，发布方据此决定是否
 * 需要避开业务高峰。
 */
export type DataMigrationLockRisk =
  /** 不产生行锁或表锁：只读，或只写进程内与文件系统副作用。 */
  | "none"
  /**
   * 只持有被写行的行锁。执行时长随行数线性增长，但锁范围不随行数扩大：
   * 实现必须是逐行或分批提交的 UPDATE/DELETE，不得把整个迁移包进一个长事务。
   */
  | "row-level"
  /** 整表重写或 DDL 级锁：执行期间相关表的并发写入会阻塞，仅在无法分批收敛时使用。 */
  | "table-level";

/**
 * 迁移的静态元信息。
 *
 * 三个字段都是**声明**而不是统计：它们在迁移执行前就固定，因此能被 runner 在执行前输出。实际影响行数
 * 属于运行期数据，由迁移经 {@link DataMigrationContext.log} 输出（见 `observableFields`），两者在发布
 * 日志里互相印证——只有声明没有实测，无法判断迁移是否真的动到了预期的数据。
 */
export interface DataMigrationMetadata {
  /**
   * 预期数据量：受影响行数/文件数的量级、上界与估算依据。
   *
   * 刻意用描述而不是数字：迁移执行前无法精确得知影响行数（授权、可见性一类的回填依赖历史数据形态），
   * 编造一个精确数字比给出量级与依据更容易误导发布方。
   */
  readonly expectedRows: string;
  /** 锁风险：见 {@link DataMigrationLockRisk}。 */
  readonly lockRisk: DataMigrationLockRisk;
  /** 可观测字段：`run` 必须输出的字段名，发布流水线据此核对进度与结果。 */
  readonly observableFields: readonly string[];
}

/**
 * 失败或回滚时的补偿方案。
 *
 * 「没有补偿」必须是显式声明而不是 `undefined`：`{ kind: "none" }` 附带 `reason`，使「评估过并判定不可
 * 补偿」与「忘了写补偿」在契约上可区分——两者对发布方的含义完全不同（前者要靠重跑收敛，后者是缺陷）。
 */
export type DataMigrationCompensation =
  /** 本迁移没有可执行的补偿；`reason` 说明为什么，以及失败后靠什么收敛到完成态。 */
  | { readonly kind: "none"; readonly reason: string }
  /** 可执行补偿：把本迁移已写入的部分撤销回执行前的状态。 */
  | { readonly kind: "handler"; readonly run: (context: DataMigrationContext) => Promise<void> };

/** 一次性的业务数据迁移。 */
export interface DataMigration {
  /**
   * 全局唯一 ID，格式 `<模块>/<YYYYMMDD>-<名字>`（日期取首次进入仓库的日期）。
   *
   * ID 是 `data_migrate_record` 的幂等判据，落库即成为发布契约：改名会被判为未应用而重跑。因此历史 ID
   * 保持原样，该格式只约束新增迁移。
   */
  readonly name: string;
  /**
   * 必须已在 `data_migrate_record` 里完成的迁移 ID；runner 在执行前校验，缺失即失败而不是跳过。
   *
   * 只表达**数据迁移** ID，不表达 DDL：runner 只在 DDL 迁移（`migrate.js`）之后执行，缺列/缺表会让迁移
   * 直接失败（fail-stop），比任何校验都早。若把 DDL 也写成 ID，就需要把 Drizzle 的 `hash`/`created_at`
   * 记录反查回 journal 的 `tag`——那条映射依赖 `drizzle-kit` 的内部存储格式，比顺序契约脆弱得多。
   */
  readonly dependsOn: readonly string[];
  /** 静态元信息：预期数据量、锁风险与可观测字段。 */
  readonly metadata: DataMigrationMetadata;
  /**
   * 幂等可重试的迁移实现。
   *
   * 「幂等」是可重试的前提：本函数可能因进程被杀、超时或后续步骤失败而被再次调用，重复执行不得产生额外
   * 副作用（同一行的二次写入、同一目录的二次分发都必须收敛）。「可重试」指失败后无需人工清理即可重跑，
   * 因此分批提交优于长事务——长事务被中断时已提交的部分与未提交的部分难以区分。
   */
  readonly run: (context: DataMigrationContext) => Promise<void>;
  /**
   * 结果校验：`run` 之后由 runner 调用，抛错即视为「迁移未完成」。
   *
   * 与 `run` 的关系是「声明 vs 实测」：`run` 报告自己做了什么，`verify` 从目标侧断言结果已经完整。校验
   * 失败时 runner 不写完成记录，下次发布才会重跑——因此 `verify` 必须能区分「数据尚未迁移」与「数据本身
   * 不符合预期」，后者要在消息里给出可人工处置的线索。
   */
  readonly verify: (context: DataMigrationContext) => Promise<void>;
  /** 失败或回滚时的补偿方案。 */
  readonly compensation: DataMigrationCompensation;
}
