// packages/chat-channel/src/sync/live/sealing.ts
// D 阶段 active → sealed 协议机（设计 §7 第 1–4 步）：给截止点 → 事务内复核前沿并登记唯一 successor 与
// 入口引用 → 重放 canonical 快照并记录终点序号/摘要/状态向量/编码长度 → 提交 sealed 状态与入口变更。
// - 只观察已提交边界：前沿、base 与 tail 全经 `ProjectionStore` 读取出口取得，本机内存不构成「已落地」的证据；
//   存储自报的连续性还要被独立复核，缺口一旦折叠进快照就被永久封存。
// - 幂等键只在存储侧：`docId + hash`（create-if-absent / 封口）与 `predecessorDocId`（唯一路由）；本机只复用同一
//   份字节与同一摘要，不自造第二套幂等。
// - 失败默认上抛原始异常；只有协议层判定可重试的错误才在本次调用内有界重试，退避属调用方调度。
// 不在这里的部分：第 1 步的冲刷合并缓冲，第 5–8 步的发布、客户端补齐与卸载（live-writer / provider）；本机不写
// successor 的字节：写入只能发生在 `seal()` 成功返回（路由与封口事务均已提交）之后。

import * as Y from "yjs";

import type { Clock, DigestFn, RandomSource } from "../clock";
import {
  isRetryableSyncErrorCode,
  type SyncErrorCode,
  SyncProtocolError,
  type SyncSafeContext,
} from "../protocol/errors";
import { assertMonotonicSeq, type DocKind, parseDocId, type SyncScope, scopeKey } from "../protocol/identity";
import type { ProjectionStore, SyncDocRecord, SyncUpdateRecord, WriterLease } from "../store/types";

export type SealingPhase = "active" | "sealing" | "sealed" | "failed";

export interface SealingDeps {
  readonly store: ProjectionStore;
  readonly clock: Clock;
  readonly digest: DigestFn;
  readonly random: RandomSource;
}

export interface SealRequest {
  readonly scope: SyncScope;
  readonly oldDocId: string;
  readonly lease: WriterLease;
  /** 截止序号：此位置之前的输入全部属于 oldDoc（设计 §7 第 1 步）。 */
  readonly finalUpdateSeq: number;
  readonly successorDocId: string;
  readonly successorInitialState: Uint8Array;
}

export interface SealResult {
  readonly docId: string;
  readonly finalUpdateSeq: number;
  readonly snapshotDigest: string;
  readonly stateVector: Uint8Array;
  readonly encodedLength: number;
  readonly dependsOn: readonly string[];
}

export interface SealingMachine {
  readonly phase: SealingPhase;
  /** 按设计 §7 的 1–4 步推进；可恢复失败有限重试，用尽或不可重试时转 failed。 */
  seal(request: SealRequest): Promise<SealResult>;
  /** 崩溃后凭已提交 tail 重建同谱系（设计 §7 第 3 步）；无可重建谱系时为 null。 */
  recover(oldDocId: string): Promise<SealResult | null>;
}

/**
 * 单次 `seal()` 内的尝试上限（含首次）。重试同步立即：本机不睡眠、不退避——退避属调用方调度（设计 §7 第 8 步
 * 的背压），在这里 `await` 定时器只会把「可重试」变成不可测的时序。用尽后转 `failed`，调用方据此停止写入。
 */
export const SEAL_MAX_ATTEMPTS = 3;

const TAIL_PAGE_SIZE = 256; // 分页大小：单次读取有界，避免恢复时把整条尾部一次拉进内存。

/** canonical 基线序号：active Doc 全由 `createDoc` 建立且它强制 `baseSeq === 0`，存储又没读回 Doc 记录的出口，
 * 读 0 号位置是唯一的基线入口。 */
const BASE_SEQ = 0;

/** `SealResult.dependsOn` 恒为空：存储没有读回 `SyncDocRecord.dependsOn` 的出口，`SealRequest` 也不携带依赖，
 * 编一份假的会让客户端入口屏障等错对象（内容块恒为空依赖是 C 阶段裁定，非空依赖由调用方在路由元数据里维护）。 */
const DEPENDS_ON: readonly string[] = [];

/** 协议错误的统一出口：稳定码 + 机器可读说明 + 安全上下文（不含正文、凭据与自由文本）。 */
function fail(code: SyncErrorCode, message: string, safeContext: SyncSafeContext): never {
  throw new SyncProtocolError(code, { message, safeContext });
}

/** 已提交谱系：基线快照 + 从基线起到截止序号为止的连续 tail。 */
interface Lineage {
  readonly baseSeq: number;
  readonly baseSnapshot: Uint8Array;
  readonly updates: readonly SyncUpdateRecord[];
  readonly lastSeq: number;
}

/** 第 3 步的产物；按 Doc 缓存，使封口重试复用同一摘要。 */
interface SealedSnapshot {
  readonly finalUpdateSeq: number;
  readonly snapshot: Uint8Array;
  readonly digest: string;
  readonly stateVector: Uint8Array;
}

/** 一个 Doc 的封口计划与其已完成的步骤。 */
interface SealAttempt {
  readonly scopeKey: string;
  readonly docId: string;
  readonly successorDocId: string;
  readonly generation: string;
  readonly kind: DocKind;
  readonly blockIndex: number;
  readonly epoch: number;
  readonly finalUpdateSeq: number;
  readonly successorInitialState: Uint8Array;
  /** 路由事务已提交：截止序号与摘要自此被钉死，异值重试必须失败而不是改写谱系。 */
  routeCommitted: boolean;
  /** 本次尝试首次登记了 successor（此前不存在）：只有这种 Doc 才确定未被既有路由引用。 */
  successorRegistered: boolean;
  lineage?: Lineage;
  sealed?: SealedSnapshot;
}

class SealingMachineImpl implements SealingMachine {
  private readonly store: ProjectionStore;
  private readonly digest: DigestFn;
  private readonly attempts = new Map<string, SealAttempt>(); // 键为 scope\0docId：裸 docId 会在另一个 scope 命中别人的计划
  private currentPhase: SealingPhase = "active";

  constructor(deps: SealingDeps) {
    this.store = deps.store;
    this.digest = deps.digest;
  }

  get phase(): SealingPhase {
    return this.currentPhase;
  }

  async seal(request: SealRequest): Promise<SealResult> {
    const attempt = this.plan(request);
    this.currentPhase = "sealing";
    try {
      const result = await this.run(attempt);
      this.currentPhase = "sealed";
      return result;
    } catch (error) {
      // 任何未收敛的失败都落到 failed：调用方需要「该谱系停止写入」的可观察信号，而非从异常类型各自推断。
      this.currentPhase = "failed";
      throw error;
    }
  }

  /**
   * 崩溃恢复：只用**已提交字节**重建同一谱系，不读本机的 `attempts`——旧写者的内存已经不存在，恢复的正确性不能依赖它。
   * 重放只 apply 已提交字节、不产生本地 struct，故同输入必同摘要，这是「重建同谱系」成立的前提；第 4 步之后崩溃时存储
   * 里的 canonical 字节就是权威，只复核它自报的摘要与读回字节一致（两处证据矛盾时没有可采信的一方）。
   * 返回 `null`：未登记、已退役，或只有基线而无已提交 tail——最后一种正是一次「预分配但未被路由引用」的孤儿的样子。
   */
  async recover(oldDocId: string): Promise<SealResult | null> {
    const base = await this.store.readDocStateAt(oldDocId, BASE_SEQ);
    if (base === null) return null;
    const tail = await this.readTail(oldDocId, base.baseSeq, null);
    if (tail.updates.length === 0) return null;
    const sealedState = await this.store.readDocStateAt(oldDocId, tail.lastSeq);
    if (sealedState === null) {
      const replayed = this.replayLineage(base.snapshot, tail.updates, oldDocId);
      return this.result(oldDocId, {
        finalUpdateSeq: tail.lastSeq,
        snapshot: replayed.snapshot,
        digest: this.digest(replayed.snapshot),
        stateVector: replayed.stateVector,
      });
    }
    if (this.digest(sealedState.snapshot) !== sealedState.hash) {
      fail("DIGEST_CONFLICT", "committed doc digest does not match its bytes", { docId: oldDocId, seq: tail.lastSeq });
    }
    return this.result(oldDocId, {
      finalUpdateSeq: tail.lastSeq,
      snapshot: sealedState.snapshot,
      digest: sealedState.hash,
      // 空 tail：只载入这段 canonical 字节再取状态向量，不重放任何增量。
      stateVector: this.replayLineage(sealedState.snapshot, [], oldDocId).stateVector,
    });
  }

  /**
   * 校验请求并取出（或建立）该 Doc 的封口计划。校验在进入 `sealing` 之前完成：畸形请求是调用方缺陷，不该把机器
   * 推进 `failed`，否则一次参数写错就让整台机器对后续 Doc 也失效。计划一旦建立即钉死——换 successor 或换截止序号
   * 是另一份计划（另建机器），不是重试。
   */
  private plan(request: SealRequest): SealAttempt {
    const key = scopeKey(request.scope);
    const docId = request.oldDocId;
    if (this.currentPhase === "sealing") fail("MALFORMED_FRAME", "seal already in progress", { scope: key });
    if (this.currentPhase === "failed") fail("MALFORMED_FRAME", "machine terminal after failed seal", { scope: key });
    if (request.lease.scopeKey !== key) fail("WRITER_EPOCH_LOST", "lease belongs to another scope", { scope: key });
    if (!Number.isSafeInteger(request.finalUpdateSeq) || request.finalUpdateSeq < 0) {
      fail("MALFORMED_FRAME", "finalUpdateSeq must be a non-negative safe integer", { scope: key, docId });
    }
    const predecessor = parseDocId(docId);
    const successor = parseDocId(request.successorDocId);
    if (request.successorDocId === docId) fail("MALFORMED_FRAME", "successor equals predecessor", { scope: key });
    // 身份不可混用（设计 §4.1）：跨代次或跨 kind 的后继会把写入入口移到另一个谱系，重启后按持久路由选入口
    // 就会写错代次。
    if (successor.kind !== predecessor.kind || successor.generation !== predecessor.generation) {
      fail("GENERATION_MISMATCH", "successor shares no generation", { docId: request.successorDocId });
    }
    const cached = this.attempts.get(`${key}\u0000${docId}`);
    if (cached !== undefined) {
      if (cached.successorDocId !== request.successorDocId || cached.finalUpdateSeq !== request.finalUpdateSeq) {
        fail("DIGEST_CONFLICT", "seal plan is pinned to another successor or cutoff", { scope: key, docId });
      }
      // epoch 不同即另一写者的计划：存储会按 epoch 拒绝其写入，缓存命中分支在这里给出同一结论。
      if (cached.epoch !== request.lease.epoch) fail("WRITER_EPOCH_LOST", "plan belongs to another epoch", { docId });
      return cached;
    }
    const attempt: SealAttempt = {
      scopeKey: key,
      docId,
      successorDocId: request.successorDocId,
      generation: predecessor.generation,
      kind: predecessor.kind,
      blockIndex: successor.blockIndex,
      epoch: request.lease.epoch,
      finalUpdateSeq: request.finalUpdateSeq,
      successorInitialState: new Uint8Array(request.successorInitialState), // 复制一份：调用方改写缓冲不得改变已登记状态
      routeCommitted: false,
      successorRegistered: false,
    };
    this.attempts.set(`${key}\u0000${docId}`, attempt);
    return attempt;
  }

  /**
   * 有界重试：只重试协议层判定可重试的错误（`isRetryableSyncErrorCode`）。结构错误、fencing 失效、摘要冲突与原始
   * 异常（存储或 Yjs 抛出的非协议错误）一律原样上抛——重放同样输入只会再失败一次。
   */
  private async run(attempt: SealAttempt): Promise<SealResult> {
    for (let attemptIndex = 1; ; attemptIndex += 1) {
      try {
        return await this.runSteps(attempt);
      } catch (error) {
        const retryable = error instanceof SyncProtocolError && isRetryableSyncErrorCode(error.code);
        if (!retryable || attemptIndex >= SEAL_MAX_ATTEMPTS) throw error;
      }
    }
  }

  private async runSteps(attempt: SealAttempt): Promise<SealResult> {
    const lineage = await this.readLineage(attempt);
    await this.registerSuccessorDoc(attempt);
    await this.registerRoute(attempt);
    const sealed = this.encodeSeal(attempt, lineage);
    return await this.commitSeal(attempt, sealed, lineage);
  }

  /**
   * 第 1–2 步的读取半边：从已提交边界取回 base 与连续 tail，并确认前沿**恰好**等于截止序号。落后表示还有未结清的
   * 批次（结果未知的批次在读取出口不可见），领先表示该截止点已不属于 oldDoc 的最后输入位置；两者都判 `SEQUENCE_GAP`，
   * 绝不「就近取一个序号」——那种封口会把尚未落地的输入静默排除在 canonical 之外，而它可能已出现在客户端可见的投影里。
   * 谱系按计划缓存并复用于所有重试；前沿的最终权威仍是路由事务内存储的校验。
   */
  private async readLineage(attempt: SealAttempt): Promise<Lineage> {
    const cached = attempt.lineage;
    if (cached !== undefined) return cached;
    const base = await this.store.readDocStateAt(attempt.docId, BASE_SEQ);
    if (base === null) fail("DOC_NOT_FOUND", "predecessor has no committed base state", { docId: attempt.docId });
    const tail = await this.readTail(attempt.docId, base.baseSeq, attempt.finalUpdateSeq);
    if (tail.lastSeq !== attempt.finalUpdateSeq) {
      fail("SEQUENCE_GAP", `durable frontier ${tail.lastSeq} is not the seal cutoff ${attempt.finalUpdateSeq}`, {
        docId: attempt.docId,
        seq: attempt.finalUpdateSeq,
      });
    }
    const lineage: Lineage = {
      baseSeq: base.baseSeq,
      baseSnapshot: base.snapshot,
      updates: tail.updates,
      lastSeq: tail.lastSeq,
    };
    attempt.lineage = lineage;
    return lineage;
  }

  /**
   * 分页读取连续 tail 并逐条复核序号连续性。存储契约承诺「遇缺口即停」，但缺口一旦被折叠进 canonical 快照就被永久封存
   * （此后读者再也看不到断裂），故对存储自报的边界再做一次独立复核：宁可失败，也不产出可疑快照（恢复路径读到尾部耗尽）。
   */
  private async readTail(
    docId: string,
    afterSeq: number,
    untilSeq: number | null,
  ): Promise<{ updates: SyncUpdateRecord[]; lastSeq: number }> {
    const updates: SyncUpdateRecord[] = [];
    let cursor = afterSeq;
    while (untilSeq === null || cursor < untilSeq) {
      // 读窗口不得越过截止序号：越过会让本机读到的前沿大于截止序号，把缺口判定从存储挪回本机。
      const limit = untilSeq === null ? TAIL_PAGE_SIZE : Math.min(TAIL_PAGE_SIZE, untilSeq - cursor);
      const page = await this.store.readUpdatesAfter(docId, cursor, limit);
      if (page.length === 0) break;
      for (const update of page) {
        assertMonotonicSeq(update.updateSeq, cursor);
        cursor = update.updateSeq;
        updates.push(update);
      }
    }
    return { updates, lastSeq: cursor };
  }

  /**
   * 第 2 步的新身份登记：successor 以 `docId + hash` create-if-absent 落库。
   * 预分配必须早于路由提交（路由只记录「谁是 successor」），否则路由先落地而 successor 还没有字节时，按持久路由
   * 选出的写入入口不可写。因此本步到路由提交之间崩溃只留下一个**未被任何路由引用**的孤儿：它不构成可恢复谱系
   * （`recover` 返回 null），字节由代次退役时的回收兜底。
   * 只登记能从请求推出的事实：身份、初始状态与初始摘要；内容块的 ordinal 范围属调用方的分配结果（`SealRequest`
   * 不携带），调用方可先用同 docId、同初始字节登记更完整的记录，本步随后看到 `already-committed` 且不改动它。
   */
  private async registerSuccessorDoc(attempt: SealAttempt): Promise<void> {
    if (attempt.successorRegistered) return;
    const doc: SyncDocRecord = {
      scopeKey: attempt.scopeKey,
      generation: attempt.generation,
      docId: attempt.successorDocId,
      kind: attempt.kind,
      state: "active",
      snapshot: attempt.successorInitialState,
      hash: this.digest(attempt.successorInitialState),
      baseSeq: BASE_SEQ,
      finalSeq: null,
      blockIndex: attempt.kind === "content" ? attempt.blockIndex : null,
      ordinalStart: null,
      ordinalEnd: null,
      dependsOn: [],
    };
    const settled = await this.store.createDoc({ scopeKey: attempt.scopeKey, epoch: attempt.epoch, doc });
    if (settled.outcome === "conflict") fail("DIGEST_CONFLICT", "successor holds other bytes", { docId: doc.docId });
    if (settled.outcome === "unknown") {
      fail("COMMIT_OUTCOME_UNKNOWN", "successor registration unknown", { docId: doc.docId });
    }
    // committed：本次首次登记。既有路由只可能引用它自己那轮登记过的 Doc，故它此刻必未被引用。
    if (settled.outcome === "committed") attempt.successorRegistered = true;
  }

  /**
   * 第 2 步的路由事务，也是本协议唯一能挡住「读取前沿之后、提交之前又落了一批更新」的关口：`registerSuccessor`
   * 在存储内用**当前**前沿比较 `expectedLastSeq`，不匹配即拒绝（`SEQUENCE_GAP`）。本机早先读到的前沿只能用于计划。
   * 路由未提交时 successor 仍是孤儿。只有「本次首次登记」的 Doc 才确定不被既有路由引用，才允许回收；已存在的 Doc
   * 可能正是那条既有路由的目标，回收它会删掉仍被引用的字节。是否真删字节由存储的可达性判定（当前代次受保护），
   * 本机不读回收结果——保留受保护的孤儿是正确结果。
   * 已知偏差：存储以**异常**形式给出的确定性失败（如前沿不匹配的 `SEQUENCE_GAP`）与「已写入但结果未确认」无法区分，
   * 故不触发回收，预分配的 Doc 保留到代次退役。影响：每个被放弃的封口计划最多残留一个未引用 Doc；移除条件：
   * `ProjectionStore` 提供路由查询出口或原子「预分配 + 路由」原语。
   */
  private async registerRoute(attempt: SealAttempt): Promise<void> {
    if (attempt.routeCommitted) return;
    const settled = await this.store.registerSuccessor({
      scopeKey: attempt.scopeKey,
      epoch: attempt.epoch,
      predecessorDocId: attempt.docId,
      successorDocId: attempt.successorDocId,
      expectedLastSeq: attempt.finalUpdateSeq,
    });
    if (settled.outcome === "committed" || settled.outcome === "already-committed") {
      attempt.routeCommitted = true;
      return;
    }
    if (settled.outcome === "unknown") {
      // 无法排除路由已指向本 successor：不得回收，按同键重试让存储给出确定答复。
      fail("COMMIT_OUTCOME_UNKNOWN", "successor route unknown", { docId: attempt.docId });
    }
    const conflict = new SyncProtocolError("DUPLICATE_OBJECT", {
      message: "predecessor already routes to another successor",
      safeContext: { docId: attempt.docId },
    });
    if (attempt.successorRegistered) {
      try {
        await this.store.retireAndCollect(attempt.scopeKey, { kind: "doc", docId: attempt.successorDocId });
      } catch (cleanupError) {
        // 回收失败不得掩盖主失败：两者一并抛出，调用方仍可从主失败的错误码追溯原始原因。
        throw new AggregateError([conflict, cleanupError], "sealing conflict and orphan reclamation failed");
      }
    }
    throw conflict;
  }

  /**
   * 第 3 步：把已提交的 base + tail 重放成 canonical 快照。产物缓存并只算一次——封口重试必须复用同一摘要，
   * 重新编码会为同一份已提交字节造出第二份候选快照，而异摘要重试正是本协议必须拒绝的事。
   */
  private encodeSeal(attempt: SealAttempt, lineage: Lineage): SealedSnapshot {
    const cached = attempt.sealed;
    if (cached !== undefined) return cached;
    const replayed = this.replayLineage(lineage.baseSnapshot, lineage.updates, attempt.docId);
    const sealed: SealedSnapshot = {
      finalUpdateSeq: attempt.finalUpdateSeq,
      snapshot: replayed.snapshot,
      digest: this.digest(replayed.snapshot),
      stateVector: replayed.stateVector,
    };
    attempt.sealed = sealed;
    return sealed;
  }

  /**
   * 第 4 步：存储事务提交 sealed 状态与入口变更（`manifestChange.activeDocId` 指向唯一 successor）。
   * `unknown` 一律先查询已提交边界：只有「截止序号处已封口且摘要一致」才算成功，确定未落地则按原字节重试，
   * 异摘要直接停写。猜成功会丢内容，猜失败会重放副作用，两种猜测都比一次有界重试更贵。
   */
  private async commitSeal(attempt: SealAttempt, sealed: SealedSnapshot, lineage: Lineage): Promise<SealResult> {
    const settled = await this.store.sealDoc({
      scopeKey: attempt.scopeKey,
      epoch: attempt.epoch,
      expectedLastSeq: attempt.finalUpdateSeq,
      docId: attempt.docId,
      finalSnapshot: sealed.snapshot,
      finalHash: sealed.digest,
      successorDocId: attempt.successorDocId,
      manifestChange: { activeDocId: attempt.successorDocId },
    });
    // 已封口且摘要不同：本机不得改写谱系，也无从「重试」出另一个结果，直接停写。
    if (settled.outcome === "conflict") {
      fail("DIGEST_CONFLICT", "document sealed with another digest; stop this lineage", { docId: attempt.docId });
    }
    // 剩余取值穷举 `CommitOutcome`：新增取值时编译器会在此处报「并非所有代码路径都有返回值」。
    switch (settled.outcome) {
      case "committed":
      case "already-committed":
        if (settled.finalSeq !== attempt.finalUpdateSeq) {
          fail("DIGEST_CONFLICT", "committed seal reports another final sequence", { docId: attempt.docId });
        }
        return this.result(attempt.docId, sealed);
      case "unknown":
        if (!(await this.confirmSealed(attempt, sealed, lineage.baseSeq))) {
          fail("COMMIT_OUTCOME_UNKNOWN", "no committed seal at the cutoff", { docId: attempt.docId });
        }
        return this.result(attempt.docId, sealed);
    }
  }

  /**
   * 结果未知后的查询：只认「截止序号处已封口且摘要一致」。截止序号等于基线序号时该位置无法区分「已封口」与
   * 「仅基线快照」（存储对 `seq === baseSeq` 一律返回基线），此时判为无法判定并交回重试：重试由存储按同幂等键
   * 给出确定答复。
   */
  private async confirmSealed(attempt: SealAttempt, sealed: SealedSnapshot, baseSeq: number): Promise<boolean> {
    if (attempt.finalUpdateSeq <= baseSeq) return false;
    const state = await this.store.readDocStateAt(attempt.docId, attempt.finalUpdateSeq);
    if (state === null) return false;
    if (state.hash !== sealed.digest || this.digest(state.snapshot) !== state.hash) {
      fail("DIGEST_CONFLICT", "seal at the cutoff holds other bytes", { docId: attempt.docId });
    }
    return true;
  }

  /** 出口结果：状态向量复制一份，本机缓存的字节不随调用方改写而变。 */
  private result(docId: string, sealed: SealedSnapshot): SealResult {
    return {
      docId,
      finalUpdateSeq: sealed.finalUpdateSeq,
      snapshotDigest: sealed.digest,
      stateVector: new Uint8Array(sealed.stateVector),
      encodedLength: sealed.snapshot.byteLength,
      dependsOn: DEPENDS_ON,
    };
  }

  /**
   * 应用 base + 连续 tail 取 canonical 快照与状态向量。
   * 重放只 apply 已提交字节、不产生本地 struct，编码结果只由输入字节里的 struct ID 与内容决定，因此同输入必同
   * 摘要：这正是「崩溃后重建同谱系」与「同摘要重试」成立的前提。
   */
  private replayLineage(
    baseSnapshot: Uint8Array,
    updates: readonly SyncUpdateRecord[],
    docId: string,
  ): { snapshot: Uint8Array; stateVector: Uint8Array } {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, baseSnapshot);
      for (const update of updates) Y.applyUpdate(doc, update.bytes);
      return { snapshot: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
    } catch (error) {
      throw this.replayFailure(docId, error);
    } finally {
      doc.destroy();
    }
  }

  /**
   * 已提交字节无法重放属存储字节损坏：重放同一段输入只会再失败一次，故按结构错误（不可重试）上抛，原始异常
   * 挂到 `cause` 供日志侧诊断。
   */
  private replayFailure(docId: string, error: unknown): SyncProtocolError {
    return new SyncProtocolError("MALFORMED_FRAME", {
      message: "committed lineage bytes could not be replayed",
      safeContext: { docId },
      cause: error,
    });
  }
}

/**
 * 创建封口协议机：`clock` 与 `random` 是接口冻结的注入位（时间与随机性一律经注入源），但本阶段既不取时也不造标识
 * ——幂等键全部由调用方给出的 docId 与字节摘要承担，重试节奏由调用方调度；保留形参是为了接线阶段不换签名。
 */
export function createSealingMachine(deps: SealingDeps): SealingMachine {
  return new SealingMachineImpl(deps);
}
