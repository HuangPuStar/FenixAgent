// provider真实Store、规划器与共享额度夹具。
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { SYNC_PROTOCOL_VERSION } from "../sync/protocol/frames";
import { buildDocId, parseDocId, type SyncScope } from "../sync/protocol/identity";
import { type AckLedger, createAckLedger } from "../sync/provider/ack-ledger";
import { type BasePlanner, createBasePlanner } from "../sync/provider/base-plan";
import { createQuotaController, type QuotaController, type TaskClass } from "../sync/provider/quota";
import {
  createProviderSession,
  type HandshakeInput,
  type ProviderSession,
  type SubscribeInput,
} from "../sync/provider/session";
import { createTailPlanner } from "../sync/provider/tail-plan";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord, SyncGenerationRecord, WriterLease } from "../sync/store/types";

export const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-1" };
export const SCOPE_KEY = "org-1/session-1";
export const GENERATION = "gen-1";
export const NEXT_GENERATION = "gen-2";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
/** 单连接窗口：额度账目与容量档案同值（装配期约束），测试才能用「填满窗口」造出零额度连接。 */
const WINDOW_BYTES = 65_536;
/** 四类等权时每类份额 = 窗口 × 权重 / 权重和，四类份额之和恰为窗口。 */
const SHARE_BYTES = WINDOW_BYTES / 4;
const TASK_CLASSES: readonly TaskClass[] = ["control", "realtime", "history-current", "history-background"];
const FAIRNESS: Record<TaskClass, number> = { control: 1, realtime: 1, "history-current": 1, "history-background": 1 };
const TAIL_MAX_BATCH_BYTES = 4_096;

/** 固定时钟：会话与存储都只经注入的时钟取时，断言不依赖真实时间推进。 */
const CLOCK: Clock = { now: () => 1_000 };

function docIdOf(kind: "control" | "directory" | "runtime", generation: string): string {
  return buildDocId({ kind, generation, blockIndex: 0, nonce: kind });
}

/** 代次入口闭包：三个单例 Doc 各一条，内容块留空（内容分发不在本层职责内）。 */
function entryRefsOf(generation: string): GenerationEntryRefs {
  return {
    controlDocId: docIdOf("control", generation),
    directoryDocId: docIdOf("directory", generation),
    runtimeDocId: docIdOf("runtime", generation),
    contentDocIds: [],
  };
}

function docRecord(generation: string, docId: string, snapshot: Uint8Array): SyncDocRecord {
  return {
    scopeKey: SCOPE_KEY,
    generation,
    docId,
    kind: parseDocId(docId).kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: null,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

function generationRecord(generation: string, entryRefs: GenerationEntryRefs): SyncGenerationRecord {
  return {
    scopeKey: SCOPE_KEY,
    generation,
    acpSessionId: "acp-session-1",
    loadId: `load-${generation}`,
    state: "staging",
    importEndOrdinal: 0,
    entryRefs,
    createdAt: CLOCK.now(),
  };
}

interface Seeded {
  readonly store: MemoryProjectionStore;
  readonly lease: WriterLease;
  readonly refs: GenerationEntryRefs;
  /** 服务端 @S 的等价物：基线 + 逐条已提交更新的真实 Yjs 文档。 */
  readonly serverDoc: Y.Doc;
  readonly snapshot: Uint8Array;
  /** 已提交 tail 的前沿序号；`appendText` 每写一条就前移一位。 */
  seq: number;
}

/** 追加一条已提交更新并推进服务端文档：模拟订阅期间发生的实时写入。 */
export async function appendText(state: Seeded, text: string): Promise<Uint8Array> {
  const content = state.serverDoc.getText("t");
  const before = Y.encodeStateVector(state.serverDoc);
  content.insert(content.length, text);
  const bytes = Y.encodeStateAsUpdate(state.serverDoc, before);
  const seq = state.seq + 1;
  await state.store.appendUpdates({
    scopeKey: SCOPE_KEY,
    epoch: state.lease.epoch,
    owner: state.lease.owner,
    batchId: `batch-${seq}`,
    digest: `digest-${seq}`,
    expectedFrontiers: [{ docId: state.refs.runtimeDocId, lastSeq: seq - 1 }],
    updates: [{ docId: state.refs.runtimeDocId, fromSeq: seq, bytes }],
  });
  state.seq = seq;
  return bytes;
}

/** 造出可握手状态：代次已提交（指针指向它）、入口 Doc 有基线快照、运行态 Doc 带可选历史更新。 */
export async function seed(steps: readonly string[] = []): Promise<Seeded> {
  const store = new MemoryProjectionStore({
    clock: CLOCK,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
  const lease = await store.acquireWriter(SCOPE_KEY, "writer-a", 60_000);
  const refs = entryRefsOf(GENERATION);
  const record = generationRecord(GENERATION, refs);
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation: record });
  const serverDoc = new Y.Doc();
  serverDoc.getText("t").insert(0, "base");
  const snapshot = Y.encodeStateAsUpdate(serverDoc);
  for (const docId of [refs.controlDocId, refs.directoryDocId, refs.runtimeDocId]) {
    await store.createDoc({ scopeKey: SCOPE_KEY, epoch: lease.epoch, doc: docRecord(GENERATION, docId, snapshot) });
  }
  const seeded: Seeded = { store, lease, refs, serverDoc, snapshot, seq: 0 };
  for (const text of steps) await appendText(seeded, text);
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    newGeneration: record,
    retired: [],
    entryClosure: refs,
  });
  return seeded;
}

/** 再提交一代：指针与 pointerRevision 一起前移，用于验证换代协商只按存储背书的修订切换。 */
export async function commitNextGeneration(state: Seeded, generation: string): Promise<GenerationEntryRefs> {
  const pointer = await state.store.readScopePointer(SCOPE_KEY);
  const refs = entryRefsOf(generation);
  const record = generationRecord(generation, refs);
  await state.store.createGeneration({ scopeKey: SCOPE_KEY, epoch: state.lease.epoch, generation: record });
  for (const docId of [refs.controlDocId, refs.directoryDocId, refs.runtimeDocId]) {
    const doc = docRecord(generation, docId, state.snapshot);
    await state.store.createDoc({ scopeKey: SCOPE_KEY, epoch: state.lease.epoch, doc });
  }
  await state.store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: state.lease.epoch,
    expectedCurrent: pointer?.currentGeneration ?? null,
    expectedPointerRevision: pointer?.pointerRevision ?? 0,
    newGeneration: record,
    retired: [],
    entryClosure: refs,
  });
  return refs;
}

interface Harness {
  readonly session: ProviderSession;
  readonly quota: QuotaController;
  readonly ledger: AckLedger;
  /** base 构建次数：零额度连接必须在构建前停住，因此它必须停在 0（不触发编码风暴）。 */
  planCalls(): number;
}

/** 连接窗口与 socket 水位同值：容量档案的 `connectionBodyWindowBytes` 是会话的预检依据，必须与额度账目一致。 */
function capacityWithWindow(connectionBodyWindowBytes: number): SyncCapacityProfile {
  return {
    ...windowCapacity(connectionBodyWindowBytes),
    concurrency: { ...DEFAULT_SYNC_CAPACITY.concurrency, connectionBodyWindowBytes },
  };
}

/** 按真实装配接线：账本归还必须回到**同一个**额度账目，否则 ACK 会凭空造字节或直接抛错。 */
export function makeHarness(store: MemoryProjectionStore, options: { maxDirtyDocs?: number } = {}): Harness {
  const quota = createQuotaController({
    maxOutstandingBytes: WINDOW_BYTES,
    socketHighWatermark: WINDOW_BYTES,
    fairness: FAIRNESS,
    maxDirtyDocs: options.maxDirtyDocs ?? 8,
  });
  const ledger = createAckLedger({ onRelease: (taskClass, bytes) => quota.release(taskClass, bytes) });
  const planner = createBasePlanner({ store, digest: sha256Digest });
  let planCalls = 0;
  const base: BasePlanner = {
    plan: (request) => {
      planCalls += 1;
      return planner.plan(request);
    },
  };
  const session = createProviderSession({
    store,
    clock: CLOCK,
    digest: sha256Digest,
    random: deterministicRandomSource("provider-session"),
    capacity: capacityWithWindow(WINDOW_BYTES),
    quota,
    ledger,
    base,
    tail: createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: TAIL_MAX_BATCH_BYTES }),
  });
  return { session, quota, ledger, planCalls: () => planCalls };
}

/** 填满连接窗口：四类各取满本轮份额（份额之和恰为窗口），此后订阅只剩有界任务引用。 */
export function fillWindow(quota: QuotaController): void {
  for (const taskClass of TASK_CLASSES) {
    if (!quota.tryReserve(taskClass, SHARE_BYTES, 0)) throw new Error(`cannot fill the window for ${taskClass}`);
  }
}

export function releaseWindow(quota: QuotaController): void {
  for (const taskClass of TASK_CLASSES) quota.release(taskClass, SHARE_BYTES);
}

export function handshakeRequest(overrides: Partial<HandshakeInput> = {}): HandshakeInput {
  return { protocolVersion: SYNC_PROTOCOL_VERSION, scope: SCOPE, generation: GENERATION, loadedDocs: [], ...overrides };
}

export function subscribeRequest(
  docId: string,
  priority: SubscribeInput["priority"] = "currentHistory",
): SubscribeInput {
  return { docIds: [docId], priority };
}

import { windowCapacity } from "./sync-window-capacity-fixture";
