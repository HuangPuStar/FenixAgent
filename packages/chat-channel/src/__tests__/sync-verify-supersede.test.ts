// packages/chat-channel/src/__tests__/sync-verify-supersede.test.ts
// 第三轮对抗验证：专攻出帧网关「单搁置位被新帧顶替」后的自结算（`AckLedger.abandon`）、搁置重试、
// 控制帧收敛边界与会话侧语义。
//
// 独立夹具：存储经 `MemoryProjectionStore` 的公开写入原语播种（真实 Y.Doc 字节），账目/会话/网关按
// `scope-runtime.ts` 的接线顺序自行装配（额度与账本共用同一个 `QuotaController`，`onDeliveryAbandoned`
// 接 `session.abandonDelivery`，`onConnectionClosed` 做唯一一次清账），另有装配级用例直接跑真实
// `createSyncScopeRuntime`。本文件不引用任何既有验证夹具或 oracle。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, type RandomSource, sha256Digest } from "../sync/clock";
import {
  decodeSyncFrame,
  encodeSyncFrame,
  frameClassOf,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
  type SyncFrameType,
} from "../sync/protocol/frames";
import { buildDocId, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { type AckLedger, createAckLedger } from "../sync/provider/ack-ledger";
import { type AckTimeoutTracker, createAckTimeoutTracker } from "../sync/provider/ack-timeout";
import { createBasePlanner } from "../sync/provider/base-plan";
import { createControlGovernor } from "../sync/provider/control-governor";
import { createQuotaController, type QuotaController, type TaskClass } from "../sync/provider/quota";
import {
  createProviderSession,
  type OutboundFrame,
  type ProviderSession,
  type SubscribePriority,
} from "../sync/provider/session";
import { createTailPlanner } from "../sync/provider/tail-plan";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfig } from "../sync/runtime/config";
import { createSyncFrameGateway, type SyncFrameGateway, type SyncFrameTransport } from "../sync/runtime/egress";
import { createSyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, ProjectionStore, SyncGenerationRecord } from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org_adversary3", rcsSessionId: "rcs_supersede" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen_adversary3";
const SEED_CLOCK: Clock = { now: () => 1_000_000 };
/** 宽限期只服务存储生命周期判定，本文件不触达回收路径。 */
const LIFECYCLE = { sealGraceMs: 1_000, retireGraceMs: 1_000 };
/** 写者租约：本文件的用例最多推进 30s 左右，追加 tail 不会遇到过期。 */
const SEED_LEASE_TTL_MS = 1_000_000_000;
/** 账目夹具的传输代次（`tx_` + 16 位标识，与 `identity.createTransportEpoch` 同形）。 */
const ACCOUNTING_EPOCH = "tx_00000000adv3rse";

// ---------- 夹具：时钟 / 随机源 / 传输 ----------

function createFakeClock(startMs = 1_000_000): { clock: Clock; advance: (ms: number) => void } {
  let nowMs = startMs;
  return { clock: { now: () => nowMs }, advance: (ms: number) => (nowMs += ms) };
}

/** 计数器随机源：同一调用序列在任何运行下产出同一批标识（本文件不复用既有夹具的随机源）。 */
function createCounterRandom(): RandomSource {
  let counter = 0n;
  return {
    bytes(length: number): Uint8Array {
      const out = new Uint8Array(length);
      const view = new DataView(out.buffer);
      if (length >= 8) {
        view.setBigUint64(0, counter);
      } else {
        for (let index = 0; index < length; index += 1) out[index] = Number((counter >> BigInt(8 * index)) & 0xffn);
      }
      counter += 1n;
      return out;
    },
  };
}

interface RecordingTransport extends SyncFrameTransport {
  readonly sentFrames: SyncFrame[];
  readonly closeReasons: string[];
  setBufferedAmount(bytes: number): void;
  /** 让接下来 n 次 send 返回 false（传输层饱和的第二种触发方式）。 */
  refuseNextSends(count: number): void;
}

function createRecordingTransport(): RecordingTransport {
  let buffered = 0;
  let refusals = 0;
  const sentFrames: SyncFrame[] = [];
  const closeReasons: string[] = [];
  return {
    sentFrames,
    closeReasons,
    send(bytes: Uint8Array): boolean {
      if (refusals > 0) {
        refusals -= 1;
        return false;
      }
      sentFrames.push(decodeSyncFrame(bytes));
      return true;
    },
    bufferedAmount: () => buffered,
    close: (reason: string) => {
      closeReasons.push(reason);
    },
    setBufferedAmount: (bytes: number) => {
      buffered = bytes;
    },
    refuseNextSends: (count: number) => {
      refusals = count;
    },
  };
}

// ---------- 夹具：存储播种 ----------

/** base 快照：真实 Y.Doc 字节（载荷大小随正文长度线性增长）。 */
function encodeBaseSnapshot(textLength: number): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "x".repeat(textLength));
  return Y.encodeStateAsUpdate(doc);
}

/** 一条已提交 tail 记录：独立 Y.Doc 的单次插入，合并与重放都合法。 */
function encodeTinyUpdate(seed: number): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("tail").insert(0, String.fromCharCode(97 + (seed % 26)));
  return Y.encodeStateAsUpdate(doc);
}

interface SeededScope {
  readonly store: ProjectionStore;
  /** 追加一批连续 tail 记录（默认起点接在该 Doc 已提交前沿之后）。 */
  appendTail(docId: string, recordCount: number): Promise<void>;
}

/**
 * 播种一个已提交代次与若干 active 内容 Doc。
 *
 * base 只锚到序号 0：`base.plan` 会把 store 里已提交的连续 tail 一并吞进 base，因此本夹具的 tail 记录
 * 一律在订阅之后按需追加——这正是真实系统里「base 之后新增内容」的形态。
 */
async function seedScope(docIds: readonly string[], baseTextLength: number): Promise<SeededScope> {
  const store = new MemoryProjectionStore({
    clock: SEED_CLOCK,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
  const lease = await store.acquireWriter(SCOPE_KEY, "seed", SEED_LEASE_TTL_MS);
  const entryRefs: GenerationEntryRefs = {
    controlDocId: buildDocId({ kind: "control", generation: GENERATION, blockIndex: 0, nonce: "c0" }),
    runtimeDocId: buildDocId({ kind: "runtime", generation: GENERATION, blockIndex: 0, nonce: "r0" }),
    directoryDocId: buildDocId({ kind: "directory", generation: GENERATION, blockIndex: 0, nonce: "y0" }),
    contentDocIds: [...docIds],
  };
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    acpSessionId: "ses_seed",
    loadId: "load_seed",
    state: "staging",
    importEndOrdinal: null,
    entryRefs,
    createdAt: 0,
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation });
  const snapshot = encodeBaseSnapshot(baseTextLength);
  for (const docId of docIds) {
    await store.createDoc({
      scopeKey: SCOPE_KEY,
      epoch: lease.epoch,
      doc: {
        scopeKey: SCOPE_KEY,
        generation: GENERATION,
        docId,
        kind: "content",
        state: "active",
        snapshot,
        hash: sha256Digest(snapshot),
        baseSeq: 0,
        finalSeq: null,
        blockIndex: null,
        ordinalStart: null,
        ordinalEnd: null,
        dependsOn: [],
      },
    });
  }
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    expectedCurrent: null,
    newGeneration: generation,
    retired: [],
    entryClosure: entryRefs,
    expectedPointerRevision: 0,
  });

  const frontiers = new Map<string, number>(docIds.map((docId) => [docId, 0]));
  let batchOrdinal = 0;
  return {
    store,
    async appendTail(docId: string, recordCount: number): Promise<void> {
      const start = (frontiers.get(docId) ?? 0) + 1;
      const updates = Array.from({ length: recordCount }, (_, offset) => ({
        docId,
        fromSeq: start + offset,
        bytes: encodeTinyUpdate(start + offset),
      }));
      batchOrdinal += 1;
      await store.appendUpdates({
        scopeKey: SCOPE_KEY,
        epoch: lease.epoch,
        owner: "seed",
        batchId: `batch_seed_${batchOrdinal}`,
        digest: sha256Digest(new Uint8Array([batchOrdinal])),
        expectedFrontiers: [{ docId, lastSeq: start - 1 }],
        updates,
      });
      frontiers.set(docId, start + recordCount - 1);
    },
  };
}

function contentDocId(nonce: string): string {
  return buildDocId({ kind: "content", generation: GENERATION, blockIndex: 0, nonce });
}

// ---------- 夹具：装配（与 scope-runtime.ts 同序接线） ----------

interface Wire {
  readonly config: SyncRuntimeConfig;
  readonly session: ProviderSession;
  readonly quota: QuotaController;
  readonly ledger: AckLedger;
  readonly timeouts: AckTimeoutTracker;
  readonly gate: SyncFrameGateway;
  readonly transport: RecordingTransport;
  /** 经 `onDeliveryAbandoned` 通知的自结算投递（顺序即顶替顺序）。 */
  readonly abandoned: string[];
  readonly state: { convergedCount: number; connectionClosed: boolean };
}

function createWire(input: {
  readonly store: ProjectionStore;
  readonly clock: Clock;
  readonly random: RandomSource;
  /** 控制帧率覆盖：默认取档案值，调小才能在用例里稳定复现「控制限流搁置」。 */
  readonly controlFramesPerSecond?: number;
}): Wire {
  const { store, clock, random } = input;
  const config = resolveSyncRuntimeConfig({
    clock,
    random,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
  const quota = createQuotaController({ ...config.quota });
  const ledger = createAckLedger({ onRelease: (taskClass, bytes) => quota.release(taskClass, bytes) });
  const session = createProviderSession({
    store,
    clock,
    digest: sha256Digest,
    random,
    capacity: config.capacity,
    quota,
    ledger,
    base: createBasePlanner({ store, digest: sha256Digest }),
    tail: createTailPlanner({
      store,
      digest: sha256Digest,
      maxBatchBytes: config.capacity.inputs.activeSoftPayloadBytes,
    }),
  });
  const control = createControlGovernor({
    clock,
    framesPerSecond: input.controlFramesPerSecond ?? config.control.framesPerSecond,
    windowBytes: config.control.windowBytes,
  });
  const timeouts = createAckTimeoutTracker({ clock, ackDeadlineMs: config.deadlines.ackMs });
  const transport = createRecordingTransport();
  const abandoned: string[] = [];
  const state = { convergedCount: 0, connectionClosed: false };
  const gate = createSyncFrameGateway({
    scope: SCOPE,
    session,
    transport,
    clock,
    config,
    control,
    timeouts,
    onDeliveryAbandoned: (deliveryId) => {
      abandoned.push(deliveryId);
      session.abandonDelivery(deliveryId);
    },
    onConnectionClosed: () => {
      state.convergedCount += 1;
      state.connectionClosed = true;
      session.close();
      ledger.reset();
      quota.reset();
      timeouts.reset();
    },
  });
  return { config, session, quota, ledger, timeouts, gate, transport, abandoned, state };
}

/** 与 `scope-runtime.tick()` 同序：先重试搁置位，再驱动会话，最后扫 ACK 超时。 */
async function drive(wire: Wire): Promise<readonly OutboundFrame[]> {
  wire.gate.driveWithheld();
  if (wire.state.connectionClosed) return [];
  const frames = await wire.session.tick();
  for (const frame of frames) wire.gate.sendOutbound(frame);
  wire.gate.scanTimeouts();
  return frames;
}

async function sendAll(wire: Wire, frames: readonly OutboundFrame[]): Promise<void> {
  for (const frame of frames) wire.gate.sendOutbound(frame);
}

async function handshakeWire(wire: Wire): Promise<readonly OutboundFrame[]> {
  const frames = await wire.session.handshake({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: SCOPE,
    generation: GENERATION,
    loadedDocs: [],
  });
  await sendAll(wire, frames);
  return frames;
}

async function subscribeWire(
  wire: Wire,
  docIds: readonly string[],
  priority: SubscribePriority = "live",
): Promise<readonly OutboundFrame[]> {
  const frames = await wire.session.subscribe({ docIds, priority });
  await sendAll(wire, frames);
  return frames;
}

/** ACK 一条已产出的数据帧：与网关 `dispatch` 同序（先注销超时登记，再由会话结清账本）。 */
async function ackProduced(wire: Wire, delivery: OutboundFrame): Promise<readonly OutboundFrame[]> {
  wire.timeouts.settle(delivery.deliveryId);
  const frames = await wire.session.onAck(delivery.deliveryId, "processed");
  await sendAll(wire, frames);
  return frames;
}

// ---------- 夹具：观测与断言 ----------

function docIdOf(frame: SyncFrame): string | null {
  return "docId" in frame ? frame.docId : null;
}

function deliveryIdOf(frame: SyncFrame): string | null {
  return "deliveryId" in frame ? frame.deliveryId : null;
}

function sentOfType(wire: Wire, type: SyncFrameType): SyncFrame[] {
  return wire.transport.sentFrames.filter((frame) => frame.type === type);
}

function sentForDoc(wire: Wire, docId: string): SyncFrame[] {
  return wire.transport.sentFrames.filter((frame) => docIdOf(frame) === docId);
}

function dataFramesOf(frames: readonly OutboundFrame[]): OutboundFrame[] {
  return frames.filter((frame) => frameClassOf(frame.frame) === "data");
}

/** 第六面不变量：账本条目数与额度字节必须同时归零或同时为正，且都不得为负。 */
function expectSingleAccount(wire: Wire, label: string): void {
  const snapshot = wire.quota.snapshot();
  expect(snapshot.outstandingBytes, `${label}：额度不得为负`).toBeGreaterThanOrEqual(0);
  expect(snapshot.pendingTasks, `${label}：在途任务数不得为负`).toBeGreaterThanOrEqual(0);
  const count = wire.ledger.outstandingCount();
  expect(count === 0, `${label}：账本(${count}) 与额度(${snapshot.outstandingBytes}) 必须同时归零或同时为正`).toBe(
    snapshot.outstandingBytes === 0,
  );
}

function helloBytes(loadedDocs: readonly string[] = []): Uint8Array {
  return encodeSyncFrame({
    type: "HELLO",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: SCOPE,
    generation: GENERATION,
    loadedDocs: loadedDocs.map((docId) => ({ docId })),
    stateful: true,
  });
}

/** 账目夹具：额度与账本共用同一实例，与 scope-runtime 的接线一致。 */
interface Accounting {
  readonly quota: QuotaController;
  readonly ledger: AckLedger;
  /** 归还记录：类目也要断言，归还到错类不会抛错，只会让公平账目静默失真。 */
  readonly releases: { taskClass: TaskClass; bytes: number }[];
  /** 授予窗口字节并登记账本：额度与账本是两本账，登记前必须先授予（与 `session.emit` 同序）。 */
  grant(deliveryId: string, bytes: number, taskClass: TaskClass): void;
}

function createAccounting(): Accounting {
  const config = resolveSyncRuntimeConfig({ clock: SEED_CLOCK, lifecycle: LIFECYCLE });
  const quota = createQuotaController({ ...config.quota });
  const releases: { taskClass: TaskClass; bytes: number }[] = [];
  const ledger = createAckLedger({
    onRelease: (taskClass, bytes) => {
      releases.push({ taskClass, bytes });
      quota.release(taskClass, bytes);
    },
  });
  return {
    quota,
    ledger,
    releases,
    grant(deliveryId: string, bytes: number, taskClass: TaskClass): void {
      expect(quota.tryReserve(taskClass, bytes, 0), `授予 ${deliveryId} 的窗口字节`).toBe(true);
      ledger.record({
        transportEpoch: ACCOUNTING_EPOCH,
        deliveryId,
        docId: "sync/content/gen_adversary3/0/a",
        fromSeq: 1,
        toSeq: 1,
        bytes,
        taskClass,
      });
    },
  };
}

/** 已上线的 DOC_UPDATE 序号区间（按上线顺序）。 */
function tailRanges(wire: Wire): { from: number; to: number }[] {
  return wire.transport.sentFrames.flatMap((frame) =>
    frame.type === "DOC_UPDATE" ? [{ from: frame.fromSeq, to: frame.toSeq }] : [],
  );
}

describe("第一面：结算守恒（abandon / settle 交错）", () => {
  test("abandon 与 settle 交错只归还一次，账本与额度是同一本账，都不得为负", () => {
    const { quota, ledger, releases, grant } = createAccounting();
    grant("dlv_a", 100, "realtime");
    grant("dlv_b", 40, "history-background");
    expect(quota.snapshot().outstandingBytes).toBe(140);

    // 先 abandon 再 ACK：第二次必须查无此投递，不得二次归还。
    expect(ledger.abandon({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_a" })).toBe(100);
    expect(quota.snapshot().outstandingBytes).toBe(40);
    expect(ledger.settle({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_a", result: "processed" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(40);
    // 同一投递被第二次顶替（重复自结算）：0 字节，不得造出额度。
    expect(ledger.abandon({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_a" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(40);
    // 归还必须落在签发时的类目上：还错类不会抛错（额度总量对得上），但公平账目会静默失真。
    expect(releases).toEqual([{ taskClass: "realtime", bytes: 100 }]);

    // 先 ACK 再 abandon：同样只归还一次。
    expect(ledger.settle({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_b", result: "rejected" })).toBe(40);
    expect(quota.snapshot().outstandingBytes).toBe(0);
    expect(ledger.abandon({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_b" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(0);
    expect(releases).toEqual([
      { taskClass: "realtime", bytes: 100 },
      { taskClass: "history-background", bytes: 40 },
    ]);

    // 异代次自结算：不释放当前代次的任何字节。
    grant("dlv_c", 70, "realtime");
    expect(ledger.abandon({ transportEpoch: "tx_other_epoch", deliveryId: "dlv_c" })).toBe(0);
    expect(ledger.settle({ transportEpoch: "tx_other_epoch", deliveryId: "dlv_c", result: "processed" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(70);
    expect(ledger.abandon({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_c" })).toBe(70);

    // 清账之后的结算：账本已空，0 字节且不得对已清零的额度归还（那会让 release 抛错）。
    grant("dlv_d", 30, "realtime");
    ledger.reset();
    quota.reset();
    expect(ledger.abandon({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_d" })).toBe(0);
    expect(ledger.settle({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_d", result: "processed" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(0);
    expect(ledger.outstandingCount()).toBe(0);
  });

  test("只清额度未清账本时自结算必须抛错暴露，而不是把额度写成负数", () => {
    const { quota, ledger, grant } = createAccounting();
    grant("dlv_x", 50, "realtime");
    // 账目错位：账本还记着 50 字节，额度已被清空（同 `convergeClosedConnection` 之外的乱序清账）。
    quota.reset();
    expect(() => ledger.abandon({ transportEpoch: ACCOUNTING_EPOCH, deliveryId: "dlv_x" })).toThrow();
    // 归还失败时记录必须保留（先归还后删条目），调用方修正账目后可用同一投递重试收敛。
    expect(ledger.outstandingCount()).toBe(1);
    expect(quota.snapshot().outstandingBytes).toBe(0);
  });

  test("装配路径：顶替触发的自结算与随后到达的迟到 ACK 不重复归还额度", async () => {
    const docA = contentDocId("pa");
    const docB = contentDocId("pb");
    const seeded = await seedScope([docA, docB], 200);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);
    const produced = await subscribeWire(wire, [docA, docB]);
    const bases = dataFramesOf(produced);
    expect(bases).toHaveLength(2);
    expect(wire.abandoned).toEqual([bases[0]!.deliveryId]);

    const inFlight = wire.quota.snapshot().outstandingBytes;
    expect(inFlight).toBe(encodeSyncFrame(bases[1]!.frame).length);
    expect(wire.ledger.outstandingCount()).toBe(1);

    // 迟到 ACK（客户端从未收到该帧）：账本里已无该条目，只能结清一次，不得凭它再归还一份额度。
    // 刻意不把回帧喂回网关：本用例只断言账目，喂回网关会叠加「控制帧顶替搁置位数据帧」的第二条链路。
    wire.timeouts.settle(bases[0]!.deliveryId);
    const late = await wire.session.onAck(bases[0]!.deliveryId, "processed");
    expect(dataFramesOf(late)).toHaveLength(0);
    expect(wire.abandoned).toEqual([bases[0]!.deliveryId]);
    expect(wire.quota.snapshot().outstandingBytes).toBe(inFlight);
    expect(wire.ledger.outstandingCount()).toBe(1);
    expectSingleAccount(wire, "迟到 ACK 之后");
  });

  test("未知 id、重复调用与 close 之后的自结算都是安全空操作", async () => {
    const docA = contentDocId("pc");
    const seeded = await seedScope([docA], 200);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);
    const produced = await subscribeWire(wire, [docA]);
    const base = dataFramesOf(produced)[0]!;

    // unknown id：不抛错、不产额度、无副作用。
    expect(() => wire.session.abandonDelivery("dlv_unknown_000000")).not.toThrow();
    expect(wire.quota.snapshot().outstandingBytes).toBe(encodeSyncFrame(base.frame).length);

    wire.gate.close("host closed the connection");
    expect(wire.state.convergedCount).toBe(1);
    expect(wire.ledger.outstandingCount()).toBe(0);
    expect(wire.quota.snapshot().outstandingBytes).toBe(0);
    // 终态之后自结算：会话已 closed，早退；账本已清空，不得二次归还。
    expect(() => wire.session.abandonDelivery(base.deliveryId)).not.toThrow();
    expect(wire.ledger.abandon({ transportEpoch: "tx_0000000000000000", deliveryId: base.deliveryId })).toBe(0);
    expect(wire.quota.snapshot().outstandingBytes).toBe(0);
    expectSingleAccount(wire, "close 之后自结算");
  });
});

describe("第二面：顶替与重试交错", () => {
  test("被顶替的投递不得被第二次交接，且归还的字节让被窗口挡住的后续帧仍能产出", async () => {
    const docIds = ["q1", "q2", "q3", "q4", "q5"].map(contentDocId);
    const seeded = await seedScope(docIds, 120_000);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);

    const first = dataFramesOf(await subscribeWire(wire, docIds));
    const frameBytes = encodeSyncFrame(first[0]!.frame).length;
    // 窗口恰好装三帧：第四帧就超（这一前提不成立时下面的判别失效，先把它钉住）。
    expect(frameBytes * 3).toBeLessThanOrEqual(wire.config.quota.maxOutstandingBytes);
    expect(frameBytes * 4).toBeGreaterThan(wire.config.quota.maxOutstandingBytes);
    expect(first).toHaveLength(3);
    // 三帧都没上线（socket 饱和）：前两帧被后一帧顶替并按传输原因自结算，只有最后一帧留在搁置位。
    expect(wire.transport.sentFrames.filter((frame) => frameClassOf(frame) === "data")).toHaveLength(0);
    expect(wire.abandoned).toEqual(first.slice(0, 2).map((frame) => frame.deliveryId));
    expect(wire.ledger.outstandingCount()).toBe(1);
    expect(wire.quota.snapshot().outstandingBytes).toBe(frameBytes);
    // 守恒交叉核对：授予总量 − 在途 = 已归还量 = 被顶替两帧的字节 + 握手控制帧（控制帧授予后立即归还）。
    const handshakeBytes = wire.transport.sentFrames.reduce((sum, frame) => sum + encodeSyncFrame(frame).length, 0);
    const accounting = wire.quota.snapshot();
    expect(accounting.grantedBytes - accounting.outstandingBytes).toBe(frameBytes * 2 + handshakeBytes);

    // 排空 socket 后再驱动一趟：搁置位那一份先按原投递上线，随后才轮到窗口里的空位。
    // 若顶替不自结算归还字节，窗口仍被三帧占满（3 × frameBytes 已接近窗口），这一趟会一帧都产不出。
    wire.transport.setBufferedAmount(0);
    const second = dataFramesOf(await drive(wire));
    // 被放弃的前两块优先恢复，不能永远停在等待不存在的 ACK。
    expect(second.map((frame) => docIdOf(frame.frame))).toEqual([docIds[0], docIds[1]]);
    expect(second.filter((frame) => wire.abandoned.includes(frame.deliveryId))).toHaveLength(0);
    expect(wire.abandoned).toHaveLength(2);
    // 窗口已占满时不重复规划，在途帧必须由真实 ACK 结算。
    expect(dataFramesOf(await drive(wire))).toHaveLength(0);
    expect(wire.abandoned).toHaveLength(2);

    const delivered = wire.transport.sentFrames.filter((frame) => frameClassOf(frame) === "data");
    const deliveredIds = new Set(delivered.map((frame) => deliveryIdOf(frame)));
    expect(deliveredIds.has(first[2]!.deliveryId), "搁置位那一份必须原样补发").toBe(true);
    for (const frame of first.slice(0, 2)) {
      expect(deliveredIds.has(frame.deliveryId), "被顶替的投递不得被第二次交接").toBe(false);
    }
    expectSingleAccount(wire, "归还字节后继续产出");
  });

  test("搁置位里的数据帧被后继控制帧顶替：按数据帧处理归还字节，不关连接", async () => {
    const docA = contentDocId("t1");
    const docB = contentDocId("t2");
    const seeded = await seedScope([docA, docB], 200);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);
    const bases = dataFramesOf(await subscribeWire(wire, [docA, docB]));
    // 搁置位现在是 docB 的 base；被它顶掉的 docA base 已自结算。
    expect(wire.abandoned).toEqual([bases[0]!.deliveryId]);
    expect(wire.ledger.outstandingCount()).toBe(1);

    // 未上线且已放弃的投递不可能有有效 ACK；伪迟到回执不得制造 BASE_READY。
    wire.timeouts.settle(bases[0]!.deliveryId);
    expect(await wire.session.onAck(bases[0]!.deliveryId, "processed")).toHaveLength(0);
    wire.transport.setBufferedAmount(0);
    const recovered = dataFramesOf(await drive(wire));
    expect(recovered).toHaveLength(1);
    expect(docIdOf(recovered[0]!.frame)).toBe(docA);
    expect(recovered[0]!.deliveryId).not.toBe(bases[0]!.deliveryId);
    expect(sentForDoc(wire, docB).filter((frame) => frameClassOf(frame) === "data")).toHaveLength(1);
    await ackProduced(wire, bases[1]!);
    await ackProduced(wire, recovered[0]!);
    expect(wire.ledger.outstandingCount()).toBe(0);
    expect(wire.transport.closeReasons).toHaveLength(0);
    expectSingleAccount(wire, "放弃基线恢复并结算");
  });

  test("顶替后搁置位里的那一份仍按传输原因重试，并被 ACK 正常结算", async () => {
    const docA = contentDocId("r1");
    const docB = contentDocId("r2");
    const seeded = await seedScope([docA, docB], 200);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);
    const produced = await subscribeWire(wire, [docA, docB]);
    const bases = dataFramesOf(produced);
    expect(wire.abandoned).toEqual([bases[0]!.deliveryId]);

    wire.transport.setBufferedAmount(0);
    const recovered = dataFramesOf(await drive(wire));
    const delivered = wire.transport.sentFrames.filter((frame) => frameClassOf(frame) === "data");
    expect(delivered).toHaveLength(2);
    expect(deliveryIdOf(delivered[0]!)).toBe(bases[1]!.deliveryId);
    expect(wire.ledger.outstandingCount()).toBe(2);
    await ackProduced(wire, recovered[0]!);
    await ackProduced(wire, bases[1]!);
    expect(wire.ledger.outstandingCount()).toBe(0);
    expect(wire.quota.snapshot().outstandingBytes).toBe(0);
    expectSingleAccount(wire, "搁置补发后 ACK");
  });

  test("同一 deliveryId 重复交接不得被误判为顶替（不得误关连接、不得重复上线）", async () => {
    const docA = contentDocId("s1");
    const seeded = await seedScope([docA], 200);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);
    const base = dataFramesOf(await subscribeWire(wire, [docA]))[0]!;

    // 同一投递再次交接：不得进搁置位的「顶替」分支（否则控制帧语义下会误关连接）。
    wire.gate.sendOutbound(base);
    wire.gate.sendOutbound(base);
    expect(wire.transport.closeReasons).toHaveLength(0);
    expect(wire.abandoned).toHaveLength(0);
    expect(wire.ledger.outstandingCount()).toBe(1);

    wire.transport.setBufferedAmount(0);
    await drive(wire);
    expect(wire.transport.sentFrames.filter((frame) => frameClassOf(frame) === "data")).toHaveLength(1);
    expect(wire.transport.closeReasons).toHaveLength(0);
  });
});

describe("第三面：控制帧顶替的关连接边界", () => {
  test("控制帧被后继帧顶替即关连接：理由可操作、只关一次、终态后不再出帧也不再自结算", async () => {
    const docA = contentDocId("c1");
    const seeded = await seedScope([docA], 200);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);

    // 先让搁置位落入一帧控制帧（BASE_READY）：base 回执在饱和之前完成，回帧在饱和之后交接。
    const base = dataFramesOf(await subscribeWire(wire, [docA]))[0]!;
    await seeded.appendTail(docA, 1);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);
    wire.timeouts.settle(base.deliveryId);
    const ready = await wire.session.onAck(base.deliveryId, "processed");
    expect(ready.map((frame) => frame.frame.type)).toEqual(["BASE_READY"]);
    await sendAll(wire, ready);
    expect(wire.transport.closeReasons).toHaveLength(0);

    // 后继数据帧顶替它：控制帧线上不带 deliveryId、没有第二次产出它的入口，只能收敛到断连。
    const tailFrames = dataFramesOf(await wire.session.tick());
    expect(tailFrames).toHaveLength(1);
    await sendAll(wire, tailFrames);
    expect(wire.transport.closeReasons).toHaveLength(1);
    expect(wire.transport.closeReasons[0]).toContain("BASE_READY");
    expect(wire.transport.closeReasons[0]).toContain("superseded");
    // 被顶替的是控制帧：不得走数据帧的自结算（那个 deliveryId 根本没进账本）。
    expect(wire.abandoned).toHaveLength(0);
    expect(wire.state.convergedCount).toBe(1);
    expect(wire.state.connectionClosed).toBe(true);
    expect(wire.session.state).toBe("closed");
    expect(wire.ledger.outstandingCount()).toBe(0);
    expect(wire.quota.snapshot().outstandingBytes).toBe(0);
    expect(wire.gate.outstandingDeliveries()).toBe(0);

    // 终态幂等：宿主再关一次、再驱动一顿都不得重复回调、重复归还或产出帧。
    wire.gate.close("host closed again");
    expect(wire.transport.closeReasons).toHaveLength(1);
    expect(wire.state.convergedCount).toBe(1);
    expect(await drive(wire)).toHaveLength(0);
    wire.gate.sendOutbound(tailFrames[0]!);
    expect(wire.gate.scanTimeouts()).toBe(0);
    expect(wire.transport.closeReasons).toHaveLength(1);
    expectSingleAccount(wire, "控制帧顶替后关连接");
  });

  test("瞬时饱和下控制帧的两种结局：无后继帧可下一 tick 补发，有后继帧立刻断连", async () => {
    const handshakeOf = async (wire: Wire): Promise<readonly OutboundFrame[]> =>
      wire.session.handshake({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        scope: SCOPE,
        generation: GENERATION,
        loadedDocs: [],
      });

    // A：搁置位里只有一帧控制帧（无后继交接），排空 socket 后由 `driveWithheld` 补发，连接保持。
    const wireA = createWire({
      store: (await seedScope([contentDocId("d1")], 200)).store,
      clock: SEED_CLOCK,
      random: createCounterRandom(),
    });
    const repliesA = await handshakeOf(wireA);
    wireA.transport.setBufferedAmount(wireA.config.quota.socketHighWatermark);
    wireA.gate.sendOutbound(repliesA[0]!);
    wireA.transport.setBufferedAmount(0);
    await drive(wireA);
    expect(sentOfType(wireA, "HELLO")).toHaveLength(1);
    expect(wireA.transport.closeReasons).toHaveLength(0);

    // B：同一饱和条件，只多了一帧待交接的控制帧（真实握手正是两帧连发）→ 立即断连。
    // 两条路径的差别只在「搁置位后面是否还有一帧」，与 socket 是否真的恢复无关。
    const wireB = createWire({
      store: (await seedScope([contentDocId("d2")], 200)).store,
      clock: SEED_CLOCK,
      random: createCounterRandom(),
    });
    const repliesB = await handshakeOf(wireB);
    wireB.transport.setBufferedAmount(wireB.config.quota.socketHighWatermark);
    await sendAll(wireB, repliesB);
    expect(sentOfType(wireB, "HELLO")).toHaveLength(0);
    expect(wireB.transport.closeReasons).toHaveLength(1);
    expect(wireB.state.convergedCount).toBe(1);
  });

  test("端到端装配：饱和下的握手控制帧互顶即关连接并清账，之后 tick 不再产帧", async () => {
    const docId = contentDocId("e1");
    const seeded = await seedScope([docId], 200);
    const clock = createFakeClock();
    const random = createCounterRandom();
    const config = resolveSyncRuntimeConfig({
      clock: clock.clock,
      random,
      capacity: DEFAULT_SYNC_CAPACITY,
      lifecycle: LIFECYCLE,
    });
    const runtime = await createSyncScopeRuntime({
      scope: SCOPE,
      config,
      clock: clock.clock,
      digest: sha256Digest,
      random,
      store: seeded.store,
    });
    const transport = createRecordingTransport();
    transport.setBufferedAmount(config.quota.socketHighWatermark);
    const gate = runtime.attachTransport(transport);

    await runtime.onInboundBytes(helloBytes([docId]));
    expect(transport.closeReasons).toHaveLength(1);
    expect(transport.closeReasons[0]).toContain("HELLO");
    expect(transport.sentFrames).toHaveLength(0);
    expect(gate.outstandingDeliveries()).toBe(0);

    // 终态之后编排者的 tick 不得再驱动会话（会话 closed、网关 closed）。
    await runtime.tick();
    expect(transport.sentFrames).toHaveLength(0);
    expect(transport.closeReasons).toHaveLength(1);
    await runtime.dispose();
  });
});

describe("第四面：会话侧自结算语义", () => {
  test("自结算不动游标：该 Doc 之后不再产帧，客户端 resync 恢复后序号从新 base 起连续", async () => {
    const docA = contentDocId("u1");
    const docB = contentDocId("u2");
    const seeded = await seedScope([docA, docB], 200);
    const wire = createWire({ store: seeded.store, clock: SEED_CLOCK, random: createCounterRandom() });
    await handshakeWire(wire);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);
    const bases = dataFramesOf(await subscribeWire(wire, [docA, docB]));
    expect(wire.abandoned).toEqual([bases[0]!.deliveryId]);
    await seeded.appendTail(docA, 3);

    // 自结算恢复可调度性，无须客户端知道自己缺了哪一块。
    wire.transport.setBufferedAmount(0);
    const rebuilt = dataFramesOf(await drive(wire))[0]!;
    expect(sentForDoc(wire, docA).filter((frame) => frameClassOf(frame) === "data")).toHaveLength(1);
    expect(wire.abandoned).toHaveLength(1);
    expect(deliveryIdOf(rebuilt.frame)).not.toBe(bases[0]!.deliveryId);
    await ackProduced(wire, rebuilt);
    // 新 base 已吞掉此前全部已提交增量（1..3），其后的增量必须从 4 起接上。
    expect(rebuilt.frame.type === "DOC_BASE" ? rebuilt.frame.baseSeq : -1).toBe(3);
    await seeded.appendTail(docA, 2);
    await drive(wire);

    // 缺口只出现在被丢的那一段：新 base 覆盖 0..3，其后增量从 4 起连续，既不跳号也不重发旧段。
    const ranges = tailRanges(wire);
    expect(ranges).toEqual([{ from: 4, to: 5 }]);
    expect(sentForDoc(wire, docA).filter((frame) => frame.type === "DOC_UPDATE")).toHaveLength(1);
  });
});

describe("第五面：回归面（搁置期限 / ACK 超时 / 终态幂等）", () => {
  test("控制限流搁置不逐 tick 重试，到期给最后一次机会且成功即保持连接", async () => {
    const seeded = await seedScope([contentDocId("v1")], 200);
    const clock = createFakeClock();
    const wire = createWire({
      store: seeded.store,
      clock: clock.clock,
      random: createCounterRandom(),
      controlFramesPerSecond: 1,
    });
    const replies = await wire.session.handshake({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: SCOPE,
      generation: GENERATION,
      loadedDocs: [],
    });
    // 唯一令牌被第一帧吃掉，第二帧被 governor 拒发（socket 未饱和，原因只能是限流）。
    await sendAll(wire, replies);
    expect(wire.transport.sentFrames).toHaveLength(1);

    await drive(wire);
    expect(wire.transport.sentFrames, "控制限流搁置不在 tick 重试").toHaveLength(1);
    expect(wire.transport.closeReasons).toHaveLength(0);

    clock.advance(wire.config.deadlines.ackMs);
    await drive(wire);
    expect(wire.transport.sentFrames, "到期最后一次机会应补发成功").toHaveLength(2);
    expect(wire.transport.closeReasons).toHaveLength(0);
  });

  test("控制限流搁置到期仍发不出去时关连接，理由含帧类型与期限", async () => {
    const seeded = await seedScope([contentDocId("w1")], 200);
    const clock = createFakeClock();
    const wire = createWire({
      store: seeded.store,
      clock: clock.clock,
      random: createCounterRandom(),
      controlFramesPerSecond: 1,
    });
    const replies = await wire.session.handshake({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: SCOPE,
      generation: GENERATION,
      loadedDocs: [],
    });
    await sendAll(wire, replies);
    expect(wire.transport.sentFrames).toHaveLength(1);

    clock.advance(wire.config.deadlines.ackMs);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);
    await drive(wire);
    expect(wire.transport.closeReasons).toHaveLength(1);
    expect(wire.transport.closeReasons[0]).toContain("MANIFEST");
    expect(wire.transport.closeReasons[0]).toContain(String(wire.config.deadlines.ackMs));
    expect(wire.state.convergedCount).toBe(1);
    expect(wire.transport.sentFrames).toHaveLength(1);
  });

  test("顶替不刷新搁置期限：期限自本段最早搁置时刻起算，到期仍发不出即关连接", async () => {
    const docA = contentDocId("x1");
    const docB = contentDocId("x2");
    const seeded = await seedScope([docA, docB], 200);
    const clock = createFakeClock();
    const wire = createWire({ store: seeded.store, clock: clock.clock, random: createCounterRandom() });
    await handshakeWire(wire);
    wire.transport.setBufferedAmount(wire.config.quota.socketHighWatermark);

    const first = dataFramesOf(await subscribeWire(wire, [docA]));
    expect(first).toHaveLength(1);
    clock.advance(wire.config.deadlines.ackMs - 1_000);
    // 后继帧顶替搁置位：期限仍从最早那一刻起算，不被新帧刷新（否则连续流量可一边丢帧一边永不超期）。
    const second = dataFramesOf(await subscribeWire(wire, [docB]));
    expect(wire.abandoned).toEqual([first[0]!.deliveryId]);

    clock.advance(1_000);
    await drive(wire);
    // 到期兜底只属于**仍搁置发不出**的那一帧（docB 的 base），已被顶替的那一份不再参与判定。
    expect(wire.transport.closeReasons).toHaveLength(1);
    expect(wire.transport.closeReasons[0]).toContain("DOC_BASE");
    expect(wire.transport.closeReasons[0]).toContain(String(wire.config.deadlines.ackMs));
    expect(wire.abandoned).toEqual([first[0]!.deliveryId]);
    expect(deliveryIdOf(second[0]!.frame)).not.toBe(first[0]!.deliveryId);
    expect(wire.state.convergedCount).toBe(1);
  });

  test("ACK 超时断连与搁置超期共用同一条清账路径，且终态之后不再产投递", async () => {
    const docA = contentDocId("v2");
    const seeded = await seedScope([docA], 200);
    const clock = createFakeClock();
    const wire = createWire({ store: seeded.store, clock: clock.clock, random: createCounterRandom() });
    await handshakeWire(wire);
    await subscribeWire(wire, [docA]);
    expect(wire.gate.outstandingDeliveries()).toBe(1);

    clock.advance(wire.config.deadlines.ackMs - 1);
    await drive(wire);
    expect(wire.transport.closeReasons).toHaveLength(0);
    clock.advance(1);
    await drive(wire);
    expect(wire.transport.closeReasons).toHaveLength(1);
    expect(wire.transport.closeReasons[0]).toContain("ack timeout");
    expect(wire.state.convergedCount).toBe(1);
    expect(wire.gate.outstandingDeliveries()).toBe(0);
    expect(wire.ledger.outstandingCount()).toBe(0);
    expect(wire.quota.snapshot().outstandingBytes).toBe(0);

    // 终态幂等 + 不再产投递：账本与额度必须同时为 0，且任何入口都不再归还字节。
    wire.gate.close("host closed again");
    expect(wire.transport.closeReasons).toHaveLength(1);
    expect(wire.state.convergedCount).toBe(1);
    expect(await drive(wire)).toHaveLength(0);
    expect(await wire.session.tick()).toHaveLength(0);
    expect(wire.gate.scanTimeouts()).toBe(0);
    expectSingleAccount(wire, "ACK 超时终态之后");
  });
});
