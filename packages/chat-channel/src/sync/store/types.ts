// packages/chat-channel/src/sync/store/types.ts
// 投影存储的 A 阶段契约：记录形状、原语入参/结果与 `ProjectionStore` 接口。
//
// 本文件只有类型与常量，没有任何运行时副作用（不取时间、不读文件、不发请求）：它是 B 阶段内存
// adapter 与接线阶段 PostgreSQL adapter 的同一份契约，换实现不换签名。所有方法返回 `Promise`——
// 真实存储是数据库访问，同步签名会迫使调用方假设「提交已经落地」，而这正是本层最不能猜的一件事。
//
// 两条贯穿全文件的规则（违反即数据串扰或重复副作用）：
// 1. 幂等键由调用方给出：`batchId + digest`（追加）、`docId + hash`（封口文档）、
//    `generation + expectedCurrent + expectedPointerRevision`（换代）、退役目标。存储只按同键判定
//    「首次落地 / 已提交 / 冲突 / 未知」，不得用时间戳或自增序号重新发明幂等。
// 2. 读取出口只观察已提交边界：未决批次、未封口的中间快照、尚未提交的指针都不属于可读状态；
//    读取方法不得返回「也许已提交」的数据。
//
// 与运行时解耦：本文件不 import `../channel`、`../state`、`../persist`，由接线阶段在调用方转换。

import type { DocKind, DocState, GenerationState } from "../protocol/identity";

/**
 * 提交类原语的统一结果。四值判定表（实现与调用方都必须按此表处理）：
 *
 * | 取值 | 判定条件 | 副作用 | 调用方动作 |
 * | --- | --- | --- | --- |
 * | `committed` | 本次调用首次落地，字节/指针/状态变更已可被读取出口观察到 | 有 | 推进（广播新前沿、续跑导入） |
 * | `already-committed` | 同幂等键（`batchId+digest` / `docId+hash` / `generation+闭包` / 退役目标）此前已成功提交 | 无：不重复追加字节、不重复写 refs、不覆盖已提交字节 | 按已提交事实继续，可安全重试到收敛 |
 * | `conflict` | 同幂等键但内容或预期不一致（摘要不同、`expectedFrontiers` / `expectedLastSeq` / `expectedCurrent` / `expectedPointerRevision` 不匹配） | 无：一个字节都不改 | 重读已提交边界或重建计划，禁止覆盖重写 |
 * | `unknown` | 无法确认本次提交是否落地（连接中断、超时、副本不可用） | 未知 | 按同幂等键重试，或读取已提交边界确认；禁止当作失败回滚，也禁止当作成功继续 |
 *
 * `unknown` 是「未知」而不是「失败」：当失败处理会重放副作用，当成功处理会把未持久化的内容
 * 宣称成已持久化。单进程的 `MemoryProjectionStore` 不会产生该值，它只为接线阶段的数据库
 * adapter 保留——那里的事务结果可能真的不可确认。
 */
export const COMMIT_OUTCOMES = ["committed", "already-committed", "conflict", "unknown"] as const;

/** 提交结果取值；判定表见 `COMMIT_OUTCOMES` 的文档注释。 */
export type CommitOutcome = (typeof COMMIT_OUTCOMES)[number];

/**
 * 每 scope 一行：写入指针（`currentGeneration` / `pointerRevision`）与 fencing 权威（writer 租约）。
 *
 * `pointerRevision` 单调递增，客户端据此拒绝旧入口回退；`writerEpoch` 每次成功 `acquireWriter`
 * 递增，旧 epoch 的写者即使租约尚未到期也不得继续写。
 */
export interface SyncScopeRow {
  scopeKey: string;
  /** 当前已提交代次；`null` 表示尚无任何代次提交（不是空字符串）。 */
  currentGeneration: string | null;
  /** 指针修订号：`commitGeneration` 与 `sealDoc` 成功时递增。 */
  pointerRevision: number;
  writerEpoch: number;
  /** 持有单写权的写者标识；无租约时为 `null`。 */
  writerOwner: string | null;
  /** 租约到期时间（注入 `Clock` 的毫秒时间戳）；`0` 表示无租约。 */
  leaseExpiresAt: number;
}

/**
 * 一个代次的入口闭包：控制面单例 Doc + 目录 Doc + 运行态 Doc + 全部内容块 Doc。
 *
 * 规格 §3.7 引用了 `GenerationEntryRefs` 但未给出定义；此处取 `CommitGenerationInput.entryClosure`
 * 的形状作为唯一定义，使「代次记录的入口引用」与「换代时提交的入口闭包」结构相同、可互相赋值。
 */
export interface GenerationEntryRefs {
  controlDocId: string;
  directoryDocId: string;
  runtimeDocId: string;
  contentDocIds: string[];
}

/**
 * 一个同步投影代次的元数据。
 *
 * `state` 判定可读性：`staging` 代次的字节不构成可读投影，`committed` 才是对外事实；
 * `importEndOrdinal` 是接收边界（`null` 表示尚未冻结，导入任务可能继续追加）；
 * `entryRefs` 是入口闭包，只在换代提交时写入一次，此后不可变。
 */
export interface SyncGenerationRecord {
  scopeKey: string;
  generation: string;
  acpSessionId: string;
  loadId: string;
  state: GenerationState;
  importEndOrdinal: number | null;
  entryRefs: GenerationEntryRefs;
  /** 创建时间（注入 `Clock` 的毫秒时间戳），仅用于生命周期宽限判定。 */
  createdAt: number;
}

/**
 * 一个 Doc 的持久记录。同一 `docId` 的已提交字节不可覆盖：`hash` 是判定键，
 * `putSealedIfAbsent` 依据它区分 `already-committed` 与 `conflict`。
 *
 * `baseSeq` 是基线快照对应的应用层序号；`finalSeq` 仅封口后非空；`blockIndex` /
 * `ordinalStart` / `ordinalEnd` 只对内容块 Doc 有值；`dependsOn` 上限见
 * `inputs.dependsOnMax`（8）。
 */
export interface SyncDocRecord {
  scopeKey: string;
  generation: string;
  docId: string;
  kind: DocKind;
  state: DocState;
  snapshot: Uint8Array;
  hash: string;
  baseSeq: number;
  finalSeq: number | null;
  blockIndex: number | null;
  ordinalStart: number | null;
  ordinalEnd: number | null;
  dependsOn: string[];
}

/**
 * 一条已提交的增量更新；唯一键是 `(scopeKey, generation, docId, updateSeq)`，
 * 幂等键是 `batchId + digest`（重复提交不得追加第二份字节）。
 *
 * 只保留 active 与封口清理宽限期内的尾部：它用于「snapshot + 连续 tail」恢复，
 * 不承诺为离线客户端永久保存整条 update 链。
 */
export interface SyncUpdateRecord {
  scopeKey: string;
  generation: string;
  docId: string;
  updateSeq: number;
  bytes: Uint8Array;
  batchId: string;
  digest: string;
}

/** 派生索引的查找类别：条目、工具调用与最终描述各自独立定位（设计 §4.4）。 */
export type RefLookupKind = "entry" | "tool" | "final";

/**
 * 一条范围定位索引；唯一键是 `(scopeKey, generation, lookupKind, lookupId, contentSlot, partIndex)`。
 *
 * 索引只定位「哪个 Doc 的哪条记录、哪段逻辑字节」，不存第二份正文：内容权威始终是 canonical
 * Yjs 记录，索引可由已提交块重建。与 canonical 记录同事务写入，因此不构成可读事实的批次不得留下索引。
 */
export interface SyncRefRecord {
  scopeKey: string;
  generation: string;
  lookupKind: RefLookupKind;
  lookupId: string;
  contentSlot: number;
  partIndex: number;
  docId: string;
  recordId: string;
  orderStart: number;
  orderEnd: number;
  byteStart: number;
  byteEnd: number;
}

/**
 * 单写权凭据：`epoch` 是 fencing 令牌，`expiresAt` 是租约到期时间。
 *
 * 凭据是「曾经取得写权」的证明而不是「现在仍可写」的证明——续期失败必须立即停写，
 * 因为 fencing 撤回不了已经在途的通知。
 */
export interface WriterLease {
  scopeKey: string;
  epoch: number;
  owner: string;
  expiresAt: number;
}

/**
 * 一个 Doc 的已提交前沿对：`lastSeq` 是「连续已提交更新的上界」（尚无更新时等于基线 `baseSeq`）。
 *
 * 它同时用于写前像（`expectedFrontiers`）与写回执（`AppendUpdatesResult.frontiers`），
 * 使「比较后写入」与「确认写到了哪」使用同一份数据。
 */
export interface DocFrontier {
  docId: string;
  lastSeq: number;
}

/**
 * 追加一组更新的入参：`expectedFrontiers` 必须逐一等于各 Doc 的当前 `lastSeq`，
 * `updates[].fromSeq` 必须等于该 Doc 当前 `lastSeq + 1`，全组在同一事务内生效。
 */
export interface AppendUpdatesInput {
  scopeKey: string;
  epoch: number;
  owner: string;
  /** 幂等键的一半：同 `batchId` 同 `digest` 视为同一批次。 */
  batchId: string;
  /** 幂等键的另一半：同 `batchId` 但 `digest` 不同即冲突，禁止覆盖已提交字节。 */
  digest: string;
  expectedFrontiers: DocFrontier[];
  updates: {
    docId: string;
    fromSeq: number;
    bytes: Uint8Array;
  }[];
  /** 与本次字节同事务写入的派生索引；不得只写索引不写正文。 */
  refs?: SyncRefRecord[];
}

/**
 * 追加结果：`frontiers` 是提交后（或此前已提交）各 Doc 的前沿，调用方可据此推进本地游标。
 *
 * `outcome` 为 `unknown` 时本字段不得被当作已提交事实（实现可返回空数组）；
 * 调用方必须先经 `readDocStateAt` / `readUpdatesAfter` 读出真实边界。
 */
export interface AppendUpdatesResult {
  outcome: CommitOutcome;
  frontiers: DocFrontier[];
}

/** create-if-absent 写入已封口文档；幂等键是 `docId + hash`。 */
export interface PutSealedInput {
  scopeKey: string;
  epoch: number;
  doc: SyncDocRecord;
}

/** 写入结果：`hash` 是已存在或本次写入的 canonical 摘要（`conflict` 时等于既有摘要）。 */
export interface PutSealedResult {
  outcome: CommitOutcome;
  hash: string;
}

/**
 * 封口当前 active 文档并按需重定向 manifest。
 *
 * `manifestChange.pointerRevision` 缺省时由存储递增：它只允许显式给出以表达「本次封口同时
 * 携带一次指针变更」，不允许用它压低已提交的修订号。
 */
export interface SealDocInput {
  scopeKey: string;
  epoch: number;
  expectedLastSeq: number;
  docId: string;
  finalSnapshot: Uint8Array;
  finalHash: string;
  /** 唯一后继路由：封口后该谱系的写入入口，重启时据此选唯一写入点。 */
  successorDocId: string;
  manifestChange: {
    directoryDocId?: string;
    activeDocId?: string;
    pointerRevision?: number;
  };
}

/** 封口结果：`finalSeq` 是封口时的应用层终点序号（`already-committed` 时返回既有终点）。 */
export interface SealDocResult {
  outcome: CommitOutcome;
  finalSeq: number;
}

/**
 * 换代与原子切换的入参：新代 `committed`、旧代 `retired`、`currentGeneration` 与
 * `pointerRevision + 1` 必须在一次提交内全部生效，任一项失败都不得留下半切换状态。
 */
export interface CommitGenerationInput {
  scopeKey: string;
  epoch: number;
  /** 写前像：必须等于当前 `currentGeneration`，否则 `conflict`。 */
  expectedCurrent: string | null;
  newGeneration: SyncGenerationRecord;
  /** 本次一并退役的旧代次；`currentGeneration` 可达的数据不在此列。 */
  retired: string[];
  entryClosure: GenerationEntryRefs;
  /** 写前像：必须等于当前 `pointerRevision`，否则 `conflict`（并发换代不得覆盖）。 */
  expectedPointerRevision: number;
}

/** 换代结果：`currentGeneration` 是提交后（或此前已提交）的当前代次。 */
export interface CommitGenerationResult {
  outcome: CommitOutcome;
  pointerRevision: number;
  currentGeneration: string;
}

/**
 * 某 Doc 在某个应用层序号处的已提交状态：`baseSeq` 是快照自身序号，`lastSeq` 是该处可见的连续前沿。
 *
 * `snapshot` 必须是可独立加载的 canonical 字节，`hash` 与其一致；两者是「已提交」的唯一证据。
 */
export interface DocStateSnapshot {
  docId: string;
  baseSeq: number;
  lastSeq: number;
  snapshot: Uint8Array;
  hash: string;
}

/**
 * 目录分页查询：`afterOrdinal` 是上一页末尾的序号游标（省略表示从最小编号开始），`limit` 为条目上限。
 *
 * 查询不带 `scopeKey`（A 阶段冻结签名）：`generation` 必须来自已鉴权 scope 下的
 * `readScopePointer` / `readGeneration`，禁止把客户端提供的 generation 直接传入。
 */
export interface DirectoryQuery {
  generation: string;
  afterOrdinal?: number;
  limit: number;
}

/**
 * 目录页：只列**已封口**的内容块（当前 active 引用在控制入口中，不进目录），按 `ordinalStart` 升序。
 *
 * `complete` 表示该代次已提交范围连续（`gaps` 为空）；`false` 时调用方不得宣称导入完整。
 * 分页是否取完由 `entries.length < limit` 判定，不由 `complete` 判定。
 */
export interface DirectoryPage {
  entries: {
    docId: string;
    ordinalStart: number;
    ordinalEnd: number;
    hash: string;
    sealed: boolean;
  }[];
  gaps: {
    afterOrdinal: number;
    beforeOrdinal: number;
  }[];
  complete: boolean;
}

/**
 * 引用分页查询：按 `(lookupKind, lookupId)` 定位，`contentSlot` 省略时跨 slot 顺序返回，
 * `afterPartIndex` 为上一页游标。
 *
 * 与 `DirectoryQuery` 同理不带 `scopeKey`：`generation` 必须来自已鉴权 scope 的读取结果。
 */
export interface RefQuery {
  generation: string;
  lookupKind: RefLookupKind;
  lookupId: string;
  contentSlot?: number;
  afterPartIndex?: number;
  limit: number;
}

/**
 * 退役与回收目标：一次只处理一个代次或一个 Doc，不提供「按 scope 全清」这类危险粒度。
 */
export type RetireTarget =
  | {
      kind: "generation";
      generation: string;
    }
  | {
      kind: "doc";
      docId: string;
    };

/**
 * 退役结果：受保护对象不得出现在 `deletedDocIds` 中，且此时 `outcome` 为 `conflict`。
 */
export interface RetireResult {
  outcome: CommitOutcome;
  /** 本次标记为 `retired` 的对象（幂等重复调用时可以为空）。 */
  retiredDocIds: string[];
  /** 本次真正删除字节的对象；GC 只按可达引用与状态判定，不按「客户端都 ACK 了」。 */
  deletedDocIds: string[];
}

/**
 * 清理宽限期：设计 §9.3 / §9.4 要求封口后的尾部与退役代次在宽限期内受保护，但没有固定数值。
 * 因此装配期必须显式给出，实现禁止内置默认值——把运维决定藏进代码会让「多久后可以回收」变成不可见的隐式契约。
 */
export interface StoreLifecycleOptions {
  /** 封口完成到尾部可回收之间的保护时长（毫秒）。 */
  sealGraceMs: number;
  /** 代次退役到字节可回收之间的保护时长（毫秒）。 */
  retireGraceMs: number;
}

/** 登记 staging 代次（设计 §5.1：调用 ACP 之前先建立 `loadId + staging generation`）。 */
export interface CreateGenerationInput {
  scopeKey: string;
  epoch: number;
  generation: SyncGenerationRecord;
}

/** 登记文档初始状态（设计 §4.1：docId 创建时即持久化；§9.1 `chat_sync_doc` 行）。 */
export interface CreateDocInput {
  scopeKey: string;
  epoch: number;
  doc: SyncDocRecord;
}

/**
 * 登记唯一 successor 路由（设计 §7 第 2 步：写入路由事务内登记 oldDoc.sealing(finalSeq)、
 * 唯一 successor 的新身份/初始状态与 currentActive 引用；事务完成后才允许写 successor）。
 */
export interface RegisterSuccessorInput {
  scopeKey: string;
  epoch: number;
  predecessorDocId: string;
  successorDocId: string;
  expectedLastSeq: number;
}

/** 登记类原语的统一结果：`committed` 新写入、`already-committed` 同键同内容重试、`conflict` 同键异内容。 */
export interface RegistrationResult {
  outcome: CommitOutcome;
}

/**
 * 投影存储：单写者 + 已提交边界读取的唯一出口。
 *
 * 与设计 §9.2 一致，本接口只暴露固定写入原语，不暴露通用工作流或事务回调：调用方无法绕过
 * 「校验 epoch → 校验前沿 → 一次提交」的顺序，也拿不到旁路已提交边界的句柄。
 * 多租户隔离由行键中的 `scopeKey` 承担（记录类型与写入入参都带它）；`readDirectory` /
 * `locateRefs` / `readDocStateAt` 按冻结签名不带 `scopeKey`，调用方必须先用已鉴权 scope
 * 取得 generation 或 docId，不得把客户端给出的标识直接传进这些读取出口。
 */
export interface ProjectionStore {
  /**
   * 取得单写权：已有未过期租约且 `owner` 不同 → 抛 `SCOPE_BUSY`（不排队、不等待）；
   * 同 `owner` 且未过期视为续租并复用同一 epoch。成功时 `writerEpoch + 1` 并写新租约，
   * 递增后的 epoch 即 fencing 令牌，旧 epoch 的写者此后一律不得再写。
   */
  acquireWriter(scopeKey: string, owner: string, ttlMs: number): Promise<WriterLease>;

  /**
   * 续租：epoch 不匹配或租约已过期 → 抛 `LEASE_EXPIRED`（调用方据此立即停写并重新取得写权）；
   * 成功返回延长后的租约。续租不改变 epoch，也不可能复活已过期的租约。
   */
  renewWriter(lease: WriterLease, ttlMs: number): Promise<WriterLease>;

  /**
   * 登记一个新的代次记录（`staging`）。幂等键 `scopeKey + generation`：同键同 `loadId` 重试 →
   * `already-committed`，同键异 `loadId`/异状态 → `conflict`（重试必须新建 loadId，不能把重放对象
   * 追加到旧目录）。epoch/租约失效抛 `WRITER_EPOCH_LOST` / `LEASE_EXPIRED`。
   */
  createGeneration(input: CreateGenerationInput): Promise<RegistrationResult>;

  /**
   * 登记文档初始状态（create-if-absent）。幂等键 `docId + hash`：同键同摘要 → `already-committed`，
   * 同键异摘要 → `conflict`（禁止覆盖已登记的 canonical 字节）；无法确认 → `unknown`。
   */
  createDoc(input: CreateDocInput): Promise<RegistrationResult>;

  /**
   * 登记封口路由：`predecessorDocId` 的唯一 `successorDocId` 与预期终点 `expectedLastSeq`。
   * 幂等键 `predecessorDocId`：同键同参 → `already-committed`，异参 → `conflict`（一个 successor 只能有一个，
   * 重复登记不同后继必须失败，否则重启后会按错误路由选写入入口）。
   */
  registerSuccessor(input: RegisterSuccessorInput): Promise<RegistrationResult>;

  /**
   * 全组原子追加（字节与 refs 同一次提交）；幂等键 `batchId + digest`：同键同摘要 → `already-committed`
   * （不重复追加字节、不重复写 refs），同键异摘要 → `conflict`（一个字节都不改）。
   * epoch/租约失效抛 `WRITER_EPOCH_LOST` / `LEASE_EXPIRED`，Doc 不存在抛 `DOC_NOT_FOUND`，
   * `fromSeq ≠ lastSeq + 1` 抛 `SEQUENCE_GAP`；无法确认是否落地时返回 `unknown`，不得猜 `committed`。
   */
  appendUpdates(input: AppendUpdatesInput): Promise<AppendUpdatesResult>;

  /**
   * create-if-absent 写已封口文档：幂等键 `docId + hash`。已存在同键 → `already-committed` 并返回
   * 既有字节（**禁止**覆盖已提交字节，异摘要 → `conflict`）；无法确认写入是否落地 → `unknown`。
   */
  putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult>;

  /**
   * 封口 active 文档：校验 epoch、`expectedLastSeq` 等于当前前沿、`successorDocId` 已登记为唯一后继，
   * 通过则原子写 `sealed`/`finalSeq`、登记目录条目与 manifest 变更，并递增 `pointerRevision`
   * （仅当 `manifestChange.pointerRevision` 未给出时由存储递增）。
   * 重复提交同 `(docId, finalHash)` → `already-committed`，异摘要 → `conflict`；无法确认 → `unknown`。
   */
  sealDoc(input: SealDocInput): Promise<SealDocResult>;

  /**
   * 原子换代：`expectedCurrent` 与 `expectedPointerRevision` 必须等于当前值，通过则新代 `committed`、
   * 旧代 `retired`、`currentGeneration` 与 `pointerRevision + 1` 一次写入；任一不匹配 → `conflict`
   * （不改任何状态），同 summary 重试 → `already-committed`（幂等，不重做导入）；无法确认 → `unknown`。
   */
  commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult>;

  /**
   * 读取某 Doc 在 `seq` 处的已提交状态；只允许观察已提交边界（未决批次、未封口的中间快照不可见）。
   * 无法给出该位置的已提交状态时返回 `null`——不得猜测，也不得返回更晚的状态充当 `seq` 处状态。
   */
  readDocStateAt(docId: string, seq: number): Promise<DocStateSnapshot | null>;

  /**
   * 读取 `(seq, …]` 上连续的已提交更新：遇缺口即停（不跳洞），按 `updateSeq` 升序，按 `limit` 截断。
   * 未提交批次不在此列，调用方据「连续区间是否覆盖到前沿」判断差分能否继续。
   */
  readUpdatesAfter(docId: string, seq: number, limit: number): Promise<SyncUpdateRecord[]>;

  /**
   * 读取 scope 指针与租约行：只返回已提交的 `currentGeneration` / `pointerRevision`，写者的未提交意图不可见。
   * scope 尚未建立时返回 `null`（不隐式创建行）。
   */
  readScopePointer(scopeKey: string): Promise<SyncScopeRow | null>;

  /**
   * 读取一个代次的元数据（状态、导入终点、入口闭包）；不存在返回 `null`。
   * 代次能否对外读取由返回的 `state` 判定（`staging`/`failed`/`retired` 都不构成可读投影）。
   */
  readGeneration(scopeKey: string, generation: string): Promise<SyncGenerationRecord | null>;

  /**
   * 目录页：只列已封口内容块，按 `ordinalStart` 升序，并明确列出缺口与是否连续。
   * 检索必须走范围索引，禁止为定位一页而遍历全历史；未提交块不得出现在页里。
   */
  readDirectory(query: DirectoryQuery): Promise<DirectoryPage>;

  /**
   * 定位引用页：返回条目/工具/最终描述的派生区间，只含已与 canonical 记录同事务提交的索引项。
   * 索引只定位不存正文，页面大小受调用方给出的 `limit` 约束（上限见容量档案的 `locatePageMaxItems`）。
   */
  locateRefs(query: RefQuery): Promise<SyncRefRecord[]>;

  /**
   * 生命周期标记与延迟删除：幂等键是 `scopeKey + target`，重复调用返回 `already-committed`。
   * **保护条件**：`currentGeneration` 可达的数据、处于封口清理宽限期的尾部、仍被恢复任务引用的
   * 代次一律不得删除，此时返回 `conflict` 且 `deletedDocIds` 为空。
   * 无法确认删除是否落地 → `unknown`，不得猜成功（猜成功的代价是把仍被引用的字节当作已回收）。
   */
  retireAndCollect(scopeKey: string, target: RetireTarget): Promise<RetireResult>;
}
