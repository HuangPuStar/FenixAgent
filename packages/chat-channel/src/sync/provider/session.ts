// provider：握手、订阅、planned → socket 交接 → processed ACK；放弃投递必须恢复调度责任。

import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn, RandomSource } from "../clock";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import {
  type BaseReadyFrame,
  type DocBaseFrame,
  type DocUpdateFrame,
  encodeSyncFrame,
  type GenerationReplaceFrame,
  type HelloFrame,
  type ManifestFrame,
  type ResyncFrame,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../protocol/frames";
import * as identity from "../protocol/identity";
import type { ProjectionStore } from "../store/types";
import type { AckLedger } from "./ack-ledger";
import type { BasePlanner } from "./base-plan";
import type { QuotaController, TaskClass } from "./quota";
import type { DocAttempt, ManifestSource, ManifestState, ReplaceInput } from "./session-internal";
import type { TailPlanner } from "./tail-plan";

export type AttemptState = "handshaking" | "ready" | "syncing" | "resync-required" | "closed";
export type RecoveryState = "ready" | "importing"; // 帧层把该取值域留给握手层定义：`importing` = 接收边界未冻结、历史可能仍不完整。
export type SubscribePriority = "live" | "currentHistory" | "backgroundHistory";

export interface ProviderSessionDeps {
  readonly store: ProjectionStore;
  readonly clock: Clock;
  readonly digest: DigestFn;
  readonly random: RandomSource;
  readonly capacity: SyncCapacityProfile;
  readonly quota: QuotaController;
  readonly ledger: AckLedger;
  readonly base: BasePlanner;
  readonly tail: TailPlanner;
}

export interface HandshakeInput {
  readonly protocolVersion: number;
  readonly scope: identity.SyncScope;
  readonly generation: string;
  readonly loadedDocs: readonly { readonly docId: string; readonly stateVector?: Uint8Array }[];
}

export interface OutboundFrame {
  readonly frame: SyncFrame;
  readonly taskClass: TaskClass;
  readonly deliveryId: string;
  /** 仅 socket 接受字节后调用；planned 预留不等于交接成功。 */
  readonly onHandedOff?: () => void;
}

export interface SubscribeInput {
  readonly docIds: readonly string[];
  readonly priority: SubscribePriority;
  /** 每 Doc 可选起点（封口 Doc 传其 finalSeq）；非信任输入，只用于选读数位置，缺省时 base 回退到规范基线。 */
  readonly requestedFromSeq?: Readonly<Record<string, number>>;
}

export interface ProviderSession {
  readonly state: AttemptState;
  handshake(input: HandshakeInput): Promise<readonly OutboundFrame[]>;
  subscribe(request: SubscribeInput): Promise<readonly OutboundFrame[]>;
  onAck(deliveryId: string, result: "processed" | "rejected"): Promise<readonly OutboundFrame[]>;
  /** 交接前放弃投递：退还预留并恢复可调度性，不能依赖尚无基线的客户端发现缺口。 */
  abandonDelivery(deliveryId: string): void;
  /** 追赶由 ACK、独立调度 tick 与订阅请求触发（设计 §8.5）。 */
  tick(): Promise<readonly OutboundFrame[]>;
  resync(docId: string): Promise<readonly OutboundFrame[]>;
  replaceGeneration(input: { generation: string; pointerRevision: number }): Promise<readonly OutboundFrame[]>;
  close(): void;
}

/** 单次调用最多 8 帧、每 Doc 每趟最多 4 批：给同连接其它 Doc 与调度让出留硬边界，一次调用做不完全部追赶。 */
const MAX_FRAMES_PER_PASS = 8;
const MAX_TAIL_BATCHES_PER_DOC = 4;
const EMPTY_FRAMES: readonly OutboundFrame[] = Object.freeze([]);
const TASK_CLASS_BY_PRIORITY: Readonly<Record<SubscribePriority, TaskClass>> = {
  live: "realtime",
  currentHistory: "history-current",
  backgroundHistory: "history-background",
};

/** 载荷编码：帧层只接受标准 base64（RFC 4648），浏览器 `atob` 亦然。 */
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const fail = (code: SyncErrorCode, message: string): SyncProtocolError => new SyncProtocolError(code, { message });

/** 成套构造：调用方已校验指针一致且记录 `committed`，这里只把代次、修订与三个入口一次装配好。 */
function manifestOf(source: ManifestSource): ManifestState {
  const { controlDocId, runtimeDocId, directoryDocId } = source.record.entryRefs;
  return {
    scope: source.scope,
    recoveryState: source.record.importEndOrdinal === null ? "importing" : "ready",
    entry: {
      generation: source.generation,
      pointerRevision: source.pointerRevision,
      // 与 pointerRevision 同源，理由见文件头偏差说明。
      referenceRevision: source.pointerRevision,
      controlDocId,
      runtimeDocId,
      directoryDocId,
    },
  };
}

function buildManifestFrame(source: ManifestState): ManifestFrame {
  return {
    type: "MANIFEST",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    ...source.entry,
    recoveryState: source.recoveryState,
  };
}

export function createProviderSession(deps: ProviderSessionDeps): ProviderSession {
  const { store, random, capacity, quota, ledger, base, tail } = deps;
  const transportEpoch = identity.createTransportEpoch(random);
  const attempts = new Map<string, DocAttempt>();
  /** planned 只占预留；handedOff 后才允许 ACK 推进 appliedSeq。 */
  const plans = new Map<string, { attempt: DocAttempt; toSeq: number; handedOff: boolean }>();
  const declaredDocs = new Map<string, Uint8Array | undefined>();
  let manifest: ManifestState | null = null;
  let pendingGenerationNotice = false;
  let state: AttemptState = "handshaking";
  // 字面量类型：帧头的 `protocolVersion` 是字面量字段，收成 `number` 会让每个数据帧都装不进帧类型。
  const protocolVersion = SYNC_PROTOCOL_VERSION;

  /** 关闭即不再产出任何帧，并清空额度与账本；账本必须先于额度清空，否则残留条目 settle 时 `onRelease` 会对已清零的额度归还字节而抛错。 */
  function closeSession(): void {
    if (state === "closed") return;
    state = "closed";
    attempts.clear();
    plans.clear();
    declaredDocs.clear();
    ledger.reset();
    quota.reset();
  }

  /** 发出一个已构建的帧：额度按**实际编码字节**申请，被拒即返回 false（调用方保留任务引用，等下次 ACK/tick 重建）；控制帧传 `range = null`，线上不带 deliveryId、客户端无从回执，故申请成功后立即归还，只保留「不得绕过总预算」的瞬时检查。 */
  function emit(
    frame: SyncFrame,
    deliveryId: string,
    taskClass: TaskClass,
    range: { readonly docId: string; readonly fromSeq: number; readonly toSeq: number } | null,
    out: OutboundFrame[],
  ): boolean {
    const bytes = encodeSyncFrame(frame);
    // bufferedAmount 取未结算字节作上界，理由见文件头偏差说明。
    if (!quota.tryReserve(taskClass, bytes.length, quota.snapshot().outstandingBytes)) return false;
    if (range === null) quota.release(taskClass, bytes.length);
    else ledger.record({ transportEpoch, deliveryId, ...range, bytes: bytes.length, taskClass });
    out.push({
      frame,
      taskClass,
      deliveryId,
      onHandedOff: () => {
        const plan = plans.get(deliveryId);
        if (plan) plan.handedOff = true;
      },
    });
    return true;
  }

  /** 数据帧通用头（设计 §8.3）：协议版本、代次、Doc、传输/订阅 epoch 与 attempt；`deliveryId` 由具体帧自己带。 */
  function frameHeader(current: ManifestState, doc: DocAttempt) {
    return {
      protocolVersion,
      docId: doc.docId,
      generation: current.entry.generation,
      transportEpoch,
      subscriptionEpoch: doc.subscriptionEpoch,
      syncAttemptId: doc.syncAttemptId,
    } as const;
  }

  function refreshState(): void {
    if (state === "closed") return;
    if (manifest === null) state = "handshaking";
    else if ([...attempts.values()].some((doc) => doc.resyncRequired)) state = "resync-required";
    else state = attempts.size > 0 ? "syncing" : "ready";
  }

  function requireManifest(action: string): ManifestState {
    if (manifest === null) throw fail("MALFORMED_FRAME", `${action} requires a completed handshake`);
    return manifest;
  }

  function createAttempt(docId: string, taskClass: TaskClass, requestedFromSeq: number | undefined): DocAttempt {
    return {
      docId,
      taskClass,
      subscriptionEpoch: identity.createSubscriptionEpoch(random),
      syncAttemptId: identity.createSyncAttemptId(random),
      needsBase: true,
      base: null,
      appliedSeq: 0,
      sendCursor: 0,
      resyncRequired: false,
      resyncNotice: null,
      busy: false,
      clientStateVector: declaredDocs.get(docId),
      requestedFromSeq,
    };
  }

  /** 推进一个 Doc：待通告 RESYNC → 探窗口 → 未发 base → 等 base 回执 → 补发 BASE_READY → 续发 tail，每次只做当前该做的那一步；被额度拒绝或还在等回执时停在
   *  原处，下一次由 ACK/tick 从同一位置重试，不需要待发队列（存储是内容权威）。返回该 Doc 是否已追平。 */
  async function pumpDoc(doc: DocAttempt, out: OutboundFrame[]): Promise<boolean> {
    if (doc.busy) return false;
    doc.busy = true;
    try {
      const current = manifest;
      if (current === null || doc.resyncRequired) return false;
      const notice = doc.resyncNotice;
      if (notice !== null) {
        // 换 attempt 已是本地事实：RESYNC 只把「旧 epoch/attempt 已废止」通告给客户端，帧延后不影响新游标。
        const frame: ResyncFrame = {
          type: "RESYNC",
          protocolVersion,
          docId: doc.docId,
          generation: current.entry.generation,
          previousSubscriptionEpoch: notice.previousSubscriptionEpoch,
          previousSyncAttemptId: notice.previousSyncAttemptId,
          attemptId: doc.syncAttemptId,
        };
        if (!emit(frame, identity.createDeliveryId(random), "control", null, out)) return false;
        doc.resyncNotice = null;
        return false;
      }
      // 载荷构建前先探窗口：零额度连接只保留「还要发什么」的任务引用，不触发编码风暴（精确判定仍以 emit 为准）。
      if (quota.snapshot().outstandingBytes >= capacity.concurrency.connectionBodyWindowBytes) return false;
      if (doc.needsBase) {
        const planned = await base.plan({
          docId: doc.docId,
          generation: current.entry.generation,
          subscriptionEpoch: doc.subscriptionEpoch,
          syncAttemptId: doc.syncAttemptId,
          clientStateVector: doc.clientStateVector,
          requestedFromSeq: doc.requestedFromSeq,
        });
        if (planned === null) {
          // 存储给不出该 Doc 的已提交状态（未知、已退役或代次不符）：不猜测，停掉该尝试并让调用方决策。
          doc.resyncRequired = true;
          throw fail("DOC_NOT_FOUND", "no readable committed state for the subscribed doc");
        }
        const deliveryId = identity.createDeliveryId(random);
        // baseSeq 取计划截止序号 S（DOC_UPDATE 从它 +1 起连续）；账本下界为 0，即 base 覆盖应用序号 0..S。
        const range = { docId: doc.docId, fromSeq: 0, toSeq: planned.upToSeq };
        const frame: DocBaseFrame = {
          type: "DOC_BASE",
          deliveryId,
          ...frameHeader(current, doc),
          baseSeq: planned.upToSeq,
          mode: planned.mode,
          payloadDigest: planned.digest,
          encodedLength: planned.encodedLength,
          payload: toBase64(planned.payload),
        };
        if (!emit(frame, deliveryId, doc.taskClass, range, out)) return false;
        plans.set(deliveryId, { attempt: doc, toSeq: range.toSeq, handedOff: false });
        doc.needsBase = false;
        doc.base = { deliveryId, upToSeq: planned.upToSeq, acked: false, readySent: false };
        doc.sendCursor = planned.upToSeq;
        return false;
      }
      const delivery = doc.base;
      if (delivery === null || !delivery.acked) return false;
      if (!delivery.readySent) {
        // 回执证明可信基线已建立：立刻补发 BASE_READY，其后才允许 tail（顺序不可换，见文件头第 1 条）。
        const frame: BaseReadyFrame = { type: "BASE_READY", ...frameHeader(current, doc), baseSeq: delivery.upToSeq };
        if (!emit(frame, identity.createDeliveryId(random), "control", null, out)) return false;
        doc.base = { ...delivery, readySent: true };
        return false;
      }
      const batches = await tail.next(doc.docId, doc.sendCursor, MAX_TAIL_BATCHES_PER_DOC);
      for (const batch of batches) {
        const deliveryId = identity.createDeliveryId(random);
        const range = { docId: doc.docId, fromSeq: batch.fromSeq, toSeq: batch.toSeq };
        const frame: DocUpdateFrame = {
          type: "DOC_UPDATE",
          deliveryId,
          ...frameHeader(current, doc),
          fromSeq: batch.fromSeq,
          toSeq: batch.toSeq,
          payloadDigest: batch.digest,
          encodedLength: batch.payload.byteLength,
          payload: toBase64(batch.payload),
        };
        if (!emit(frame, deliveryId, doc.taskClass, range, out)) return false;
        plans.set(deliveryId, { attempt: doc, toSeq: range.toSeq, handedOff: false });
        doc.sendCursor = batch.toSeq;
      }
      return batches.length === 0;
    } finally {
      doc.busy = false;
    }
  }

  /** 一趟追赶：先补发待通告的换代，再逐个 Doc 推进；「被额度拒绝」不终止本趟，份额公平由额度层裁决。 */
  async function pump(): Promise<readonly OutboundFrame[]> {
    const out: OutboundFrame[] = [];
    const current = manifest;
    if (state === "closed" || current === null) return out;
    if (pendingGenerationNotice) {
      const frame: GenerationReplaceFrame = { type: "GENERATION_REPLACE", protocolVersion, ...current.entry };
      if (emit(frame, identity.createDeliveryId(random), "control", null, out)) pendingGenerationNotice = false;
    }
    for (const doc of [...attempts.values()]) {
      if (out.length >= MAX_FRAMES_PER_PASS) break;
      if (await pumpDoc(doc, out)) quota.clearDirty(doc.docId);
    }
    refreshState();
    return out;
  }

  async function handshake(input: HandshakeInput): Promise<readonly OutboundFrame[]> {
    if (state === "closed") return EMPTY_FRAMES;
    // 连接身份不可重绑：scope/generation 的重协商发生在重连后的新会话上（设计 §8.3 会话绑定）。
    if (manifest !== null) throw fail("MALFORMED_FRAME", "handshake already completed for this connection");
    if (input.protocolVersion !== protocolVersion) throw fail("PROTOCOL_VERSION_UNSUPPORTED", "unsupported version");
    const key = identity.scopeKey(input.scope);
    const pointer = await store.readScopePointer(key);
    // 指针是唯一权威：客户端提出的代次必须已是本 scope 已提交的当前代次，否则先按 MANIFEST 重新协商。
    const isCurrent = pointer !== null && pointer.currentGeneration === input.generation;
    if (!isCurrent) throw fail("GENERATION_NOT_CURRENT", "handshake generation is not the committed one");
    const record = await store.readGeneration(key, input.generation);
    if (record === null) throw fail("GENERATION_MISMATCH", "handshake generation is unknown to this scope");
    // staging/failed/retired 代次的字节不构成可读投影：握手期就拒绝，避免下发半成品历史。
    if (record.state !== "committed") throw fail("GENERATION_NOT_CURRENT", "handshake generation is not readable");
    const scope = { organizationId: input.scope.organizationId, rcsSessionId: input.scope.rcsSessionId };
    const generation = input.generation;
    manifest = manifestOf({ scope, generation, pointerRevision: pointer.pointerRevision, record });
    // 客户端声明的可信基线只收本代次入口闭包内的 Doc：未知或异代 Doc 不予确认，回执里自然不出现。
    const { controlDocId, runtimeDocId, directoryDocId, contentDocIds } = record.entryRefs;
    const known = new Set([controlDocId, runtimeDocId, directoryDocId, ...contentDocIds]);
    for (const { docId, stateVector } of input.loadedDocs) {
      if (known.has(docId) && !declaredDocs.has(docId)) declaredDocs.set(docId, stateVector);
    }
    // 回执只确认「服务端认得的 Doc」，不替客户端声明它已应用到哪个序号——那个数字服务端无从核实。
    const loadedDocs = [...declaredDocs.keys()].map((docId) => ({ docId }));
    const hello: HelloFrame = { type: "HELLO", protocolVersion, scope, generation, loadedDocs, stateful: true };
    const out: OutboundFrame[] = [];
    // 握手帧必须立即发出：握手期连控制预算都用不上说明注入的额度/水位配置不成立，不能把连接停在半握手状态。
    const ok =
      emit(hello, identity.createDeliveryId(random), "control", null, out) &&
      emit(buildManifestFrame(manifest), identity.createDeliveryId(random), "control", null, out);
    if (!ok) {
      closeSession(); // 半握手状态不可留：额度/水位配置连握手帧都装不下，连接所有权在调用方。
      throw fail("CAPACITY_EXCEEDED", "cannot carry the handshake frames");
    }
    refreshState();
    return out;
  }

  async function subscribe(request: SubscribeInput): Promise<readonly OutboundFrame[]> {
    if (state === "closed") return EMPTY_FRAMES;
    const current = requireManifest("subscribe");
    const taskClass = TASK_CLASS_BY_PRIORITY[request.priority];
    if (taskClass === undefined) throw fail("MALFORMED_FRAME", "unknown subscribe priority");
    for (const docId of request.docIds) {
      // 代次一致性就是隔离边界：读取出口不带 scopeKey，故「docId 内嵌代次 == 本会话代次」是唯一可用判据（设计 §8.3）。
      identity.assertIdentifier(docId, "docIds[]");
      const belongs = identity.parseDocId(docId).generation === current.entry.generation;
      if (!belongs) throw fail("GENERATION_MISMATCH", "docId does not belong to the current generation");
      if ((await store.readDocStateAt(docId, 0)) === null) throw fail("DOC_NOT_FOUND", "docId has no committed state");
      try {
        quota.markDirty(docId);
      } catch (error) {
        closeSession(); // dirty 超限（`maxDirtyDocs`）要求关闭连接：会话先自锁（不再产出帧），连接所有权在调用方。
        throw error;
      }
      attempts.set(docId, createAttempt(docId, taskClass, request.requestedFromSeq?.[docId]));
    }
    return pump();
  }

  async function onAck(deliveryId: string, result: "processed" | "rejected"): Promise<readonly OutboundFrame[]> {
    if (state === "closed") return EMPTY_FRAMES;
    const plan = plans.get(deliveryId);
    if (plan === undefined) return EMPTY_FRAMES;
    ledger.settle({ transportEpoch, deliveryId, result });
    // 未交接的回执可能是传输层「已写但 send 返回 false」：只结清预留，不能越过尚未发生的交接推进基线顺序。
    if (!plan.handedOff) return EMPTY_FRAMES;
    plans.delete(deliveryId);
    // 引用不等即旧 attempt 的迟到回执：只结清原账本，不改动新 attempt 的 base/游标（设计 §8.3）。
    if (attempts.get(plan.attempt.docId) !== plan.attempt) return EMPTY_FRAMES;
    const doc = plan.attempt;
    if (result === "rejected") {
      // rejected 只清传输额度并进入 resync：base/appliedSeq 不推进，等显式 resync 换新 attempt（设计 §8.6 第 4 条）。
      doc.resyncRequired = true;
      refreshState();
      return EMPTY_FRAMES;
    }
    // base 回执是 BASE_READY 的唯一前提；tail 回执只推进应用边界，且该边界只增不减（回执可能乱序到达）。
    if (doc.base !== null && doc.base.deliveryId === deliveryId) doc.base = { ...doc.base, acked: true };
    doc.appliedSeq = Math.max(doc.appliedSeq, plan.toSeq);
    return pump();
  }

  /** 基线未上线可原子回滚；tail 已可能乱序交接，换 attempt 并通告重建。 */
  function abandonDelivery(deliveryId: string): void {
    const plan = plans.get(deliveryId);
    if (state === "closed" || !plan || plan.handedOff) return;
    ledger.abandon({ transportEpoch, deliveryId });
    plans.delete(deliveryId);
    const doc = plan.attempt;
    if (attempts.get(doc.docId) !== doc) return;
    if (doc.base?.deliveryId === deliveryId) {
      doc.base = null;
      doc.needsBase = true;
      doc.sendCursor = 0;
    } else {
      const next = createAttempt(doc.docId, doc.taskClass, doc.requestedFromSeq);
      next.resyncNotice = {
        previousSubscriptionEpoch: doc.subscriptionEpoch,
        previousSyncAttemptId: doc.syncAttemptId,
      };
      attempts.set(doc.docId, next);
    }
  }

  async function resync(docId: string): Promise<readonly OutboundFrame[]> {
    if (state === "closed") return EMPTY_FRAMES;
    requireManifest("resync");
    const previous = attempts.get(docId);
    if (previous === undefined) throw fail("DOC_NOT_FOUND", "resync requires an existing attempt for this docId");
    const next = createAttempt(docId, previous.taskClass, previous.requestedFromSeq);
    next.resyncNotice = {
      previousSubscriptionEpoch: previous.subscriptionEpoch,
      previousSyncAttemptId: previous.syncAttemptId,
    };
    attempts.set(docId, next);
    return pump();
  }

  async function replaceGeneration(input: ReplaceInput): Promise<readonly OutboundFrame[]> {
    if (state === "closed") return EMPTY_FRAMES;
    const current = requireManifest("replaceGeneration");
    identity.assertIdentifier(input.generation, "generation");
    const revision = input.pointerRevision;
    const key = identity.scopeKey(current.scope);
    const pointer = await store.readScopePointer(key);
    if (pointer === null) throw fail("GENERATION_MISMATCH", "scope pointer is not readable");
    // 修订号必须由存储背书：接受尚未提交的修订会把客户端带到不存在的入口上。
    const stale = revision < current.entry.pointerRevision || revision < pointer.pointerRevision;
    if (stale) throw fail("POINTER_REVISION_STALE", "revision is older than the committed pointer");
    if (revision > pointer.pointerRevision) throw fail("GENERATION_MISMATCH", "revision is not committed");
    if (revision === current.entry.pointerRevision) {
      // 同 revision 必须是同一次重传：异代次即冲突（拒绝而不是就地切换），一致重传没有需要切换或通告的变化。
      const sameGeneration = input.generation === current.entry.generation;
      if (!sameGeneration) throw fail("GENERATION_MISMATCH", "same revision with a different generation");
      return EMPTY_FRAMES;
    }
    if (pointer.currentGeneration !== input.generation) throw fail("GENERATION_NOT_CURRENT", "target is not current");
    const record = await store.readGeneration(key, input.generation);
    const usable = record !== null && record.state === "committed";
    if (!usable) throw fail("GENERATION_NOT_CURRENT", "target generation is not readable");
    // 成套切换：代次、修订与三个入口一次换掉；旧 attempt 全部作废（它们的在途帧仍会结清原账本）。
    for (const doc of attempts.values()) quota.clearDirty(doc.docId);
    attempts.clear();
    declaredDocs.clear();
    manifest = manifestOf({ scope: current.scope, generation: input.generation, pointerRevision: revision, record });
    pendingGenerationNotice = true;
    return pump();
  }

  return {
    get state(): AttemptState {
      return state;
    },
    handshake,
    subscribe,
    onAck,
    abandonDelivery,
    tick: pump,
    resync,
    replaceGeneration,
    close: closeSession,
  };
}
