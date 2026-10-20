// packages/chat-channel/src/__tests__/sync-provider-session.test.ts
// E 阶段 provider 会话编排（设计 §8.3–§8.5）行为验证：握手、订阅、base → BASE_READY → tail、ACK、resync 与换代。
// 只断言对外可观测事实（帧序列与字段、额度与账本账目、会话状态）：存储、规划器与帧编解码全用真实实现，
// 因此每个出站帧都真实过一遍 `encodeSyncFrame` / `decodeSyncFrame` 往返，载荷也真实过一遍 Yjs 应用。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  decodeSyncFrame,
  encodeSyncFrame,
  MAX_FRAME_HEADER_BYTES,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../sync/protocol/frames";
import { buildDocId, parseDocId, type SyncScope } from "../sync/protocol/identity";
import { type AckLedger, createAckLedger } from "../sync/provider/ack-ledger";
import { type BasePlanner, createBasePlanner } from "../sync/provider/base-plan";
import { createQuotaController, type QuotaController, type TaskClass } from "../sync/provider/quota";
import {
  createProviderSession,
  type HandshakeInput,
  type OutboundFrame,
  type ProviderSession,
  type SubscribeInput,
} from "../sync/provider/session";
import { createTailPlanner } from "../sync/provider/tail-plan";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord, SyncGenerationRecord, WriterLease } from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-1" };
const SCOPE_KEY = "org-1/session-1";
const GENERATION = "gen-1";
const NEXT_GENERATION = "gen-2";
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
async function appendText(state: Seeded, text: string): Promise<Uint8Array> {
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
async function seed(steps: readonly string[] = []): Promise<Seeded> {
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
async function commitNextGeneration(state: Seeded, generation: string): Promise<GenerationEntryRefs> {
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
    ...DEFAULT_SYNC_CAPACITY,
    concurrency: { ...DEFAULT_SYNC_CAPACITY.concurrency, connectionBodyWindowBytes },
  };
}

/** 按真实装配接线：账本归还必须回到**同一个**额度账目，否则 ACK 会凭空造字节或直接抛错。 */
function makeHarness(store: MemoryProjectionStore, options: { maxDirtyDocs?: number } = {}): Harness {
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
function fillWindow(quota: QuotaController): void {
  for (const taskClass of TASK_CLASSES) {
    if (!quota.tryReserve(taskClass, SHARE_BYTES, 0)) throw new Error(`cannot fill the window for ${taskClass}`);
  }
}

function releaseWindow(quota: QuotaController): void {
  for (const taskClass of TASK_CLASSES) quota.release(taskClass, SHARE_BYTES);
}

function handshakeRequest(overrides: Partial<HandshakeInput> = {}): HandshakeInput {
  return { protocolVersion: SYNC_PROTOCOL_VERSION, scope: SCOPE, generation: GENERATION, loadedDocs: [], ...overrides };
}

function subscribeRequest(docId: string, priority: SubscribeInput["priority"] = "currentHistory"): SubscribeInput {
  return { docIds: [docId], priority };
}

/** 每个出站帧都必须原样过一遍帧层编解码：字段缺失、越界或非法 base64 会在编码阶段直接抛错。 */
function roundTrip(frames: readonly OutboundFrame[]): SyncFrame[] {
  return frames.map((item) => decodeSyncFrame(encodeSyncFrame(item.frame)));
}

function typesOf(frames: readonly OutboundFrame[]): string[] {
  return roundTrip(frames).map((frame) => frame.type);
}

/** 取指定类型的帧：判别字段已由往返编解码验证，类型在这里收窄到对应成员。 */
function frameOf<T extends SyncFrame["type"]>(
  frames: readonly OutboundFrame[],
  type: T,
): Extract<SyncFrame, { type: T }> {
  const matched = roundTrip(frames).find((frame) => frame.type === type);
  if (matched === undefined) throw new Error(`frame ${type} is missing`);
  return matched as Extract<SyncFrame, { type: T }>;
}

/** 把 base 与 tail 载荷应用到空文档，验证客户端重建出的状态与服务端一致。 */
function rebuildFrom(basePayload: string, updatePayloads: readonly string[]): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(basePayload, "base64")));
  for (const payload of updatePayloads) Y.applyUpdate(doc, new Uint8Array(Buffer.from(payload, "base64")));
  return doc;
}

/** 断言调用以指定协议码失败：错误码是稳定契约，消息文本不是。 */
async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof SyncProtocolError) return error.code;
    throw error;
  }
  throw new Error("expected a SyncProtocolError");
}

describe("provider session", () => {
  // 握手只产出 HELLO 与 MANIFEST 两条控制帧：入口、修订与恢复状态齐备，历史正文一律留给订阅阶段。
  test("handshake 产出 HELLO 回执与 MANIFEST 入口，不携带全历史正文", async () => {
    const seeded = await seed(["marker".repeat(1_500)]);
    const harness = makeHarness(seeded.store);
    expect(harness.session.state).toBe("handshaking");
    const frames = await harness.session.handshake(
      handshakeRequest({
        loadedDocs: [{ docId: seeded.refs.runtimeDocId, stateVector: Y.encodeStateVector(seeded.serverDoc) }],
      }),
    );
    expect(typesOf(frames)).toEqual(["HELLO", "MANIFEST"]);
    const hello = frameOf(frames, "HELLO");
    expect([hello.scope, hello.generation, hello.stateful]).toEqual([SCOPE, GENERATION, true]);
    expect(hello.loadedDocs.map((doc) => doc.docId)).toEqual([seeded.refs.runtimeDocId]);
    const manifest = frameOf(frames, "MANIFEST");
    expect([manifest.generation, manifest.pointerRevision, manifest.referenceRevision]).toEqual([GENERATION, 1, 1]);
    expect([manifest.recoveryState, manifest.controlDocId, manifest.directoryDocId, manifest.runtimeDocId]).toEqual([
      "ready",
      seeded.refs.controlDocId,
      seeded.refs.directoryDocId,
      seeded.refs.runtimeDocId,
    ]);
    // 已提交历史远大于帧头预算：MANIFEST 仍落在头预算内，正文没有被塞进握手。
    expect(encodeSyncFrame(manifest).length).toBeLessThanOrEqual(MAX_FRAME_HEADER_BYTES);
    expect([harness.session.state, harness.planCalls()]).toEqual(["ready", 0]);
  });

  // 零额度连接只保留「还要发什么」的有界任务引用：不构建 base、不产出编码帧，也不报错。
  test("零额度订阅只保留有界任务引用，额度归还后由 tick 续上", async () => {
    const seeded = await seed(["one"]);
    const open = makeHarness(seeded.store);
    await open.session.handshake(handshakeRequest());
    expect(typesOf(await open.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId)))).toEqual(["DOC_BASE"]);

    const blocked = makeHarness(seeded.store);
    await blocked.session.handshake(handshakeRequest());
    fillWindow(blocked.quota);
    const frames = await blocked.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    // 帧数下降而不是报错：窗口已满时订阅成功返回，只是没有可编码帧。
    expect(frames).toHaveLength(0);
    expect(blocked.planCalls()).toBe(0);
    // 额度归还后不需要重新订阅：tick 从同一位置续上，帧数回到正常连接的 1 帧。
    releaseWindow(blocked.quota);
    expect(typesOf(await blocked.session.tick())).toEqual(["DOC_BASE"]);
  });

  // 顺序不可换：DOC_BASE → 客户端 processed 回执 → BASE_READY → S+1 起的连续 DOC_UPDATE。
  test("base 回执后才发 BASE_READY，其后才发 S+1 起的连续 tail", async () => {
    const seeded = await seed(["one", "two"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const base = frameOf(subscribed, "DOC_BASE");
    expect([base.mode, base.baseSeq]).toEqual(["full", 2]);
    expect(base.payloadDigest).toBe(sha256Digest(new Uint8Array(Buffer.from(base.payload, "base64"))));
    // 回执未到：既不补 BASE_READY，也不发 tail。
    expect(await harness.session.tick()).toHaveLength(0);

    subscribed[0].onHandedOff?.();
    const readyFrames = await harness.session.onAck(subscribed[0].deliveryId, "processed");
    expect(typesOf(readyFrames)).toEqual(["BASE_READY"]);
    expect(frameOf(readyFrames, "BASE_READY").baseSeq).toBe(base.baseSeq);

    // 订阅之后发生的新写入：tail 必须从 S+1 起连续。
    await appendText(seeded, "three");
    const tailFrames = await harness.session.tick();
    expect(typesOf(tailFrames)).toEqual(["DOC_UPDATE"]);
    const update = frameOf(tailFrames, "DOC_UPDATE");
    expect([update.fromSeq, update.toSeq]).toEqual([base.baseSeq + 1, base.baseSeq + 1]);
    expect(update.payloadDigest).toBe(sha256Digest(new Uint8Array(Buffer.from(update.payload, "base64"))));
    expect([update.docId, update.generation]).toEqual([seeded.refs.runtimeDocId, GENERATION]);
    // 帧头完整性：同一次订阅内代次、epoch 与 attempt 一致，投递号各不相同。
    expect([update.transportEpoch, update.subscriptionEpoch, update.syncAttemptId]).toEqual([
      base.transportEpoch,
      base.subscriptionEpoch,
      base.syncAttemptId,
    ]);
    expect(new Set([base.deliveryId, update.deliveryId]).size).toBe(2);
    // 载荷真实可用：base + tail 重建出的状态与服务端文档一致。
    const rebuilt = rebuildFrom(base.payload, [update.payload]);
    expect(rebuilt.getText("t").toString()).toBe(seeded.serverDoc.getText("t").toString());

    // 回执结清传输额度：两帧全部结算后窗口回到零。
    tailFrames[0].onHandedOff?.();
    await harness.session.onAck(tailFrames[0].deliveryId, "processed");
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);
    expect(harness.ledger.outstandingCount()).toBe(0);
  });

  // 未交接基线被放弃时必须恢复调度责任，迟到回执不能替未到达的基线确认完成。
  test("abandonDelivery 归还窗口字节但不推进游标，重复调用与未知 id 无副作用", async () => {
    const seeded = await seed(["one", "two"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const base = frameOf(subscribed, "DOC_BASE");
    const reserved = harness.quota.snapshot().outstandingBytes;
    expect(reserved).toBeGreaterThan(0);

    harness.session.abandonDelivery(base.deliveryId);
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);
    expect(harness.ledger.outstandingCount()).toBe(0);
    // 幂等：同一条再丢弃一次不归还第二份（重复归还会凭空造额度）。
    harness.session.abandonDelivery(base.deliveryId);
    harness.session.abandonDelivery("dlv_0011223344556677");
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);

    expect(await harness.session.onAck(base.deliveryId, "processed")).toHaveLength(0);
    const retried = await harness.session.tick();
    expect(typesOf(retried)).toEqual(["DOC_BASE"]);
    expect(retried[0].deliveryId).not.toBe(base.deliveryId);
    retried[0].onHandedOff?.();
    expect(typesOf(await harness.session.onAck(retried[0].deliveryId, "processed"))).toEqual(["BASE_READY"]);
  });

  // rejected 只结清传输额度并进入 resync：不推进 base、不发 BASE_READY、不发 tail。
  test("rejected 回执只结清传输额度并进入 resync，不推进 base 与游标", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const base = frameOf(subscribed, "DOC_BASE");

    subscribed[0].onHandedOff?.();
    expect(await harness.session.onAck(subscribed[0].deliveryId, "rejected")).toHaveLength(0);
    expect(harness.session.state).toBe("resync-required");
    // 传输额度已结清，但业务边界没动：既没有 BASE_READY，也没有尾部更新。
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);
    expect(harness.ledger.outstandingCount()).toBe(0);
    expect(await harness.session.tick()).toHaveLength(0);

    // 补齐走显式 resync：通告旧 attempt 已废止，并换新 attempt 重新协商 base。
    const notice = frameOf(await harness.session.resync(seeded.refs.runtimeDocId), "RESYNC");
    expect([notice.previousSubscriptionEpoch, notice.previousSyncAttemptId]).toEqual([
      base.subscriptionEpoch,
      base.syncAttemptId,
    ]);
    const again = frameOf(await harness.session.tick(), "DOC_BASE");
    expect([again.syncAttemptId, again.mode, again.baseSeq]).toEqual([notice.attemptId, "full", base.baseSeq]);
    expect(again.subscriptionEpoch).not.toBe(base.subscriptionEpoch);
  });

  // 旧 attempt 的迟到回执只结清原账本：不 apply、不改新游标，新 attempt 仍要自己的回执才 READY。
  test("resync 废止旧任务，旧 attempt 的迟到回执不改新游标", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const first = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const stale = frameOf(first, "DOC_BASE");
    const staleBytes = encodeSyncFrame(first[0].frame).length;

    const notice = frameOf(await harness.session.resync(seeded.refs.runtimeDocId), "RESYNC");
    const freshFrames = await harness.session.tick();
    freshFrames[0].onHandedOff?.();
    first[0].onHandedOff?.();
    const fresh = frameOf(freshFrames, "DOC_BASE");
    expect(fresh.syncAttemptId).toBe(notice.attemptId);
    expect(fresh.deliveryId).not.toBe(stale.deliveryId);
    const outstanding = harness.quota.snapshot().outstandingBytes;

    // 迟到回执：只归还旧帧占用的额度，新 attempt 的游标与 base 一步不动。
    expect(await harness.session.onAck(first[0].deliveryId, "processed")).toHaveLength(0);
    expect(harness.quota.snapshot().outstandingBytes).toBe(outstanding - staleBytes);
    expect(await harness.session.tick()).toHaveLength(0);
    expect(harness.session.state).toBe("syncing");

    // 新 attempt 自己的回执才是它 READY 的依据。
    expect(typesOf(await harness.session.onAck(fresh.deliveryId, "processed"))).toEqual(["BASE_READY"]);
  });

  // 换代只认存储背书的修订：更高 revision 且为当前代次才成套切换，同 revision 只接受一致重传。
  test("换代只接受更高或同 revision 的一致重传，并成套切换入口", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const nextRefs = await commitNextGeneration(seeded, NEXT_GENERATION);

    // 旧 revision、未提交的更高 revision、以及 revision 到位但代次不是当前代次：全部拒绝。
    const replace = harness.session.replaceGeneration.bind(harness.session);
    expect([
      await codeOf(() => replace({ generation: NEXT_GENERATION, pointerRevision: 1 })),
      await codeOf(() => replace({ generation: NEXT_GENERATION, pointerRevision: 3 })),
      await codeOf(() => replace({ generation: GENERATION, pointerRevision: 2 })),
    ]).toEqual(["POINTER_REVISION_STALE", "GENERATION_MISMATCH", "GENERATION_NOT_CURRENT"]);

    // 更高 revision 且目标为当前代次：成套切换，通告里带齐代次、修订与三个入口。
    const replaced = frameOf(
      await harness.session.replaceGeneration({ generation: NEXT_GENERATION, pointerRevision: 2 }),
      "GENERATION_REPLACE",
    );
    expect(replaced).toEqual({
      type: "GENERATION_REPLACE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      generation: NEXT_GENERATION,
      pointerRevision: 2,
      referenceRevision: 2,
      controlDocId: nextRefs.controlDocId,
      directoryDocId: nextRefs.directoryDocId,
      runtimeDocId: nextRefs.runtimeDocId,
    });
    // 旧代次的订阅随之作废：同一帧不再续发，旧 docId 也被代次一致性挡在门外。
    expect(await harness.session.tick()).toHaveLength(0);
    expect(await codeOf(() => harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId)))).toBe(
      "GENERATION_MISMATCH",
    );
    expect(
      frameOf(await harness.session.subscribe(subscribeRequest(nextRefs.runtimeDocId)), "DOC_BASE").generation,
    ).toBe(NEXT_GENERATION);

    // 同 revision 一致重传幂等；同 revision 异代次是冲突，不能就地切走。
    expect(await replace({ generation: NEXT_GENERATION, pointerRevision: 2 })).toHaveLength(0);
    expect(await codeOf(() => replace({ generation: GENERATION, pointerRevision: 2 }))).toBe("GENERATION_MISMATCH");
  });

  // dirty 集合是「连接跟不上了」的信号：超过 maxDirtyDocs 必须关闭连接并要求重新握手。
  test("dirty 集合超过 maxDirtyDocs 时关闭连接并要求重新握手", async () => {
    const seeded = await seed();
    const harness = makeHarness(seeded.store, { maxDirtyDocs: 2 });
    await harness.session.handshake(handshakeRequest());
    const docIds = [seeded.refs.controlDocId, seeded.refs.runtimeDocId, seeded.refs.directoryDocId];

    expect(await codeOf(() => harness.session.subscribe({ docIds, priority: "live" }))).toBe("CAPACITY_EXCEEDED");
    // 会话自锁：不再产出任何帧，连接所有权交回调用方。
    expect(harness.session.state).toBe("closed");
    expect(await harness.session.tick()).toHaveLength(0);
  });

  // 关闭即终态：不再产出任何帧，额度与账本同时清账。
  test("close 之后不再产出任何帧", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    expect(harness.ledger.outstandingCount()).toBe(1);

    harness.session.close();
    expect(harness.session.state).toBe("closed");
    expect(await harness.session.tick()).toHaveLength(0);
    expect(await harness.session.onAck(subscribed[0].deliveryId, "processed")).toHaveLength(0);
    expect(await harness.session.resync(seeded.refs.runtimeDocId)).toHaveLength(0);
    expect(await harness.session.replaceGeneration({ generation: GENERATION, pointerRevision: 1 })).toHaveLength(0);
    expect(await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId))).toHaveLength(0);
    expect(await harness.session.handshake(handshakeRequest())).toHaveLength(0);
    // 关即清账：在途投递与占用额度一并归零。
    expect([harness.quota.snapshot().outstandingBytes, harness.ledger.outstandingCount()]).toEqual([0, 0]);
  });
});
