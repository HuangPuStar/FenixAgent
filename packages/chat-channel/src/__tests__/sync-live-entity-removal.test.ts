// packages/chat-channel/src/__tests__/sync-live-entity-removal.test.ts
// X2 回归：终态实体必须在 `final` 的同一批次移出运行态。
//
// 缺陷根因：`capture` 用 `Y.encodeStateVector` 前后比对判定「本事务是否产生更新」，而纯删除只改删除集、
// 不推进 state vector，于是 `removeEntity` 产生的 slice 被静默丢弃——运行态只落 upsert，幽灵实体留在
// 客户端与服务端投影里，并且只在该 Doc 的下一次写入时被顺带落库（封口后无新写入时永久残留）。
//
// 断言跑在真实 `MemoryProjectionStore` 上，「重建」一律走客户端恢复路径（canonical base 快照 + 连续已提交
// tail），不看写者内存 Doc：内存 Doc 里的删除是本地副作用，不能证明删除已落库。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { captureChange } from "../sync/live/change-capture";
import {
  type BarrierKind,
  createLiveWriter,
  type LiveInput,
  type LiveRecordValue,
  type LiveWriter,
} from "../sync/live/live-writer";
import type { RotationControllerOptions } from "../sync/live/rotation";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS, type RuntimeEntityRecord } from "../sync/live/runtime-doc";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  AppendUpdatesInput,
  AppendUpdatesResult,
  GenerationEntryRefs,
  ProjectionStore,
  SyncDocRecord,
  SyncGenerationRecord,
} from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-final" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen-1";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
/** 引导租约：夹具用它登记代次与文档，随后过期，把写权让给被测写者。 */
const BOOTSTRAP_TTL_MS = 5_000;
/** 合并窗口远大于用例时长：正文冲刷只由屏障推动，不依赖真实定时器。 */
const MERGE = { maxDelayMs: 600_000, maxBytes: 1 << 20 };

interface TimeControl {
  readonly clock: Clock;
  advance(ms: number): void;
}

interface Runtime {
  readonly store: MemoryProjectionStore;
  readonly time: TimeControl;
  readonly capacity: SyncCapacityProfile;
  readonly runtimeId: string;
  readonly contentId: string;
}

/** 可推进的测试时钟：租约过期与轮换期限都由它驱动，实现不得读真实时间。 */
function testTime(start = 1_000): TimeControl {
  let now = start;
  return { clock: { now: () => now }, advance: (ms) => (now += ms) };
}

function docIdFor(kind: DocKind, blockIndex: number, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex, nonce });
}

/** 空 Doc 的 canonical 字节：内容块与运行态 Doc 都以它为基线登记。 */
function emptyState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

function docRecord(docId: string, kind: DocKind, blockIndex: number, snapshot: Uint8Array): SyncDocRecord {
  return {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/** 建一个有已提交代次的作用域：代次未成为当前代次时存储会按 `GENERATION_NOT_CURRENT` 拒绝写者的全部写入。 */
async function seed(runtime: Runtime): Promise<void> {
  const { store, time } = runtime;
  const entryRefs: GenerationEntryRefs = {
    controlDocId: docIdFor("control", 0, "control"),
    directoryDocId: docIdFor("directory", 0, "directory"),
    runtimeDocId: runtime.runtimeId,
    contentDocIds: [runtime.contentId],
  };
  const lease = await store.acquireWriter(SCOPE_KEY, "bootstrap", BOOTSTRAP_TTL_MS);
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    acpSessionId: "acp-session-1",
    loadId: "load-1",
    state: "staging",
    importEndOrdinal: null,
    entryRefs,
    createdAt: 1_000,
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    newGeneration: generation,
    entryClosure: entryRefs,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(runtime.runtimeId, "runtime", 0, emptyState()),
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(runtime.contentId, "content", 0, emptyState()),
  });
  time.advance(BOOTSTRAP_TTL_MS + 1);
}

interface AppendCall {
  readonly batchId: string;
  readonly updates: readonly { readonly docId: string; readonly fromSeq: number }[];
}

/** 只记录提交入参的存储代理：批次边界是「同一批次」这条不变量的唯一证据，替身自证会掩盖实现与契约的分歧。 */
function recordingStore(target: ProjectionStore, calls: AppendCall[]): ProjectionStore {
  return new Proxy(target, {
    get(source, property, receiver) {
      const value: unknown = Reflect.get(source, property, receiver);
      if (property !== "appendUpdates" || typeof value !== "function") return value;
      return async (input: AppendUpdatesInput): Promise<AppendUpdatesResult> => {
        calls.push({
          batchId: input.batchId,
          updates: input.updates.map((update) => ({ docId: update.docId, fromSeq: update.fromSeq })),
        });
        return await source.appendUpdates(input);
      };
    },
  }) as ProjectionStore;
}

interface Fixture extends Runtime {
  readonly writer: LiveWriter;
  readonly calls: AppendCall[];
}

async function setup(seedName: string): Promise<Fixture> {
  const time = testTime();
  const capacity = DEFAULT_SYNC_CAPACITY;
  const runtime: Runtime = {
    store: new MemoryProjectionStore({ clock: time.clock, digest: sha256Digest, capacity, lifecycle: LIFECYCLE }),
    time,
    capacity,
    runtimeId: docIdFor("runtime", 0, "runtime"),
    contentId: docIdFor("content", 0, "content"),
  };
  await seed(runtime);
  const calls: AppendCall[] = [];
  const rotation: RotationControllerOptions = {
    clock: time.clock,
    random: deterministicRandomSource("rotation"),
    limits: RUNTIME_DOC_LIMITS,
    maxResidentMs: 600_000,
    maxTransactions: 1_000,
  };
  const writer = createLiveWriter({
    scope: SCOPE,
    store: recordingStore(runtime.store, calls),
    clock: time.clock,
    digest: sha256Digest,
    random: deterministicRandomSource(seedName),
    capacity,
    merge: MERGE,
    limits: RUNTIME_DOC_LIMITS,
    rotation,
  });
  await writer.acquire();
  return { ...runtime, writer, calls };
}

function semantic(kind: BarrierKind, payload: Record<string, unknown>): LiveInput {
  return {
    turnId: "turn-1",
    entryId: "entry-1",
    contentSlot: "0",
    contentType: "tool",
    kind: "semantic",
    semantic: { kind, payload },
  };
}

/** 终态事件：默认用规范形态 `kind: "final"`；`eventKind` 可换成声明实体类别的等价形态（如 `permission`）。 */
function finalOf(entityId: string, finalKind: "tool" | "permission", eventKind: BarrierKind = "final"): LiveInput {
  return semantic(eventKind, {
    entityId,
    finalDescriptor: {
      kind: finalKind,
      contentRef: `blk/${entityId}`,
      digest: `dg/${entityId}`,
      byteLength: 8,
      completedAt: 1_700_000_000_000,
    },
  });
}

/** 客户端恢复路径：canonical base 快照 + 连续已提交 tail。 */
function reconstruct(fixture: Fixture, docId: string): Y.Doc {
  const state = fixture.store.exportCommittedState();
  const stored = state.docs.find((doc) => doc.docId === docId);
  if (stored === undefined) throw new Error(`document ${docId} is not committed`);
  const doc = new Y.Doc({ guid: docId });
  Y.applyUpdate(doc, stored.baseSnapshot);
  for (const update of state.updates.filter((entry) => entry.docId === docId)) Y.applyUpdate(doc, update.bytes);
  return doc;
}

function committedUpdates(fixture: Fixture, docId: string) {
  return fixture.store.exportCommittedState().updates.filter((update) => update.docId === docId);
}

function entitiesOf(doc: Y.Doc): RuntimeEntityRecord[] {
  return createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, doc).exportForRotation();
}

function recordsOf(doc: Y.Doc): LiveRecordValue[] {
  const records = doc.getMap<unknown>("root").get("records");
  return records instanceof Y.Array ? (records.toArray() as LiveRecordValue[]) : [];
}

describe("纯删除的事务捕获", () => {
  // 删除只改删除集、不推进 state vector：旧的 state vector 比对会把它判成「无变化」，本用例锁住「删除必须产出更新」。
  test("纯删除不推进 state vector，但仍产出可重建删除的更新", () => {
    const source = new Y.Doc();
    const entities = source.getMap<string>("runtime");
    const inserted = captureChange(source, () => entities.set("entity-1", JSON.stringify({ state: "open" })));
    expect(inserted).not.toBeNull();
    const before = Y.encodeStateVector(source);
    const deleted = captureChange(source, () => entities.delete("entity-1"));
    const after = Y.encodeStateVector(source);
    expect(after.byteLength).toBe(before.byteLength);
    expect([...after].every((byte, index) => byte === before[index])).toBe(true);
    expect(deleted).not.toBeNull();

    // 接收方按序号顺序应用两条更新：插入可见再删除，最终为空。
    const witness = new Y.Doc();
    if (inserted !== null) Y.applyUpdate(witness, inserted);
    expect(witness.getMap<string>("runtime").has("entity-1")).toBe(true);
    if (deleted !== null) Y.applyUpdate(witness, deleted);
    expect(witness.getMap<string>("runtime").has("entity-1")).toBe(false);
  });

  // 无变更的事务不得产出空更新：空事务与「删除不存在的键」都不占序号，否则批次区间会多出一格。
  test("无变更的事务不产出更新（空事务与删除不存在的键）", () => {
    const doc = new Y.Doc();
    const entities = doc.getMap<string>("runtime");
    captureChange(doc, () => entities.set("entity-1", JSON.stringify({ state: "open" })));
    expect(captureChange(doc, () => {})).toBeNull();
    expect(captureChange(doc, () => entities.delete("missing"))).toBeNull();
    captureChange(doc, () => entities.delete("entity-1"));
    expect(captureChange(doc, () => entities.delete("entity-1"))).toBeNull();
  });

  // 内容块 Doc 走同一条捕获路径：records 数组上删掉一条记录同样必须落成更新，否则内容侧会静默丢删除。
  test("内容块 Doc 删除记录同样被捕获并可由 tail 重建", () => {
    const source = new Y.Doc();
    const root = source.getMap<unknown>("root");
    const record: LiveRecordValue = {
      recordId: "rec-1",
      entryId: "entry-1",
      contentSlot: "0",
      contentType: "text/plain",
      partIndex: 0,
      kind: "text",
      payload: new TextEncoder().encode("hello"),
    };
    const appended = captureChange(source, () => {
      const array = new Y.Array<LiveRecordValue>();
      root.set("records", array);
      array.push([record]);
    });
    const removed = captureChange(source, () => {
      const array = root.get("records");
      if (array instanceof Y.Array) array.delete(0, 1);
    });
    expect(appended).not.toBeNull();
    expect(removed).not.toBeNull();

    const witness = new Y.Doc();
    if (appended !== null) Y.applyUpdate(witness, appended);
    if (removed !== null) Y.applyUpdate(witness, removed);
    const witnessed = witness.getMap<unknown>("root").get("records");
    expect(witnessed instanceof Y.Array ? witnessed.length : -1).toBe(0);
  });
});

describe("final 同批次移出运行态", () => {
  // final 的描述符与运行态删除必须落在同一个批次：一次 appendUpdates、两条 update、同一 batchId。
  test("final 的一条批次里内容块落描述符、运行态落删除", async () => {
    const fixture = await setup("final-batch");
    await fixture.writer.accept(semantic("tool", { entityId: "entity_removed", toolCallId: "tc_removed" }));
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId)).map((entity) => entity.entityId)).toEqual([
      "entity_removed",
    ]);
    const beforeFinal = fixture.calls.length;

    await fixture.writer.accept(finalOf("entity_removed", "tool"));

    const finalCalls = fixture.calls.slice(beforeFinal);
    expect(finalCalls.length).toBe(1);
    expect([...finalCalls[0].updates.map((update) => update.docId)].sort()).toEqual(
      [fixture.contentId, fixture.runtimeId].sort(),
    );
    expect(new Set(finalCalls[0].updates.map((update) => update.docId)).size).toBe(2);
    // 症状断言：客户端按恢复路径重建出的运行态里不得留下已终态实体。
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId))).toEqual([]);
    // 根因断言：运行态必须落两条更新（upsert + 删除），删除不能等下一次写入顺带带上。
    expect(committedUpdates(fixture, fixture.runtimeId).map((update) => update.updateSeq)).toEqual([1, 2]);
    // 描述符仍必须落在内容块里，删除不等于丢掉交接位置。
    const finals = recordsOf(reconstruct(fixture, fixture.contentId)).filter((record) => record.kind === "final");
    expect(finals.map((record) => record.entryId)).toEqual(["entity_removed"]);
  });

  // 终态由描述符决定而不是由 kind 决定：声明实体类别（permission）并携带描述符的等价形态同样移出实体。
  test("带终态描述符的 permission 事件同样移出运行态实体", async () => {
    const fixture = await setup("final-permission-descriptor");
    await fixture.writer.accept(semantic("permission", { entityId: "perm-1", toolCallId: "call-a" }));
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId)).map((entity) => entity.entityId)).toEqual(["perm-1"]);
    const beforeFinal = fixture.calls.length;

    await fixture.writer.accept(finalOf("perm-1", "permission", "permission"));

    const finalCalls = fixture.calls.slice(beforeFinal);
    expect(finalCalls.length).toBe(1);
    expect(new Set(finalCalls[0].updates.map((update) => update.docId)).size).toBe(2);
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId))).toEqual([]);
    expect(committedUpdates(fixture, fixture.runtimeId).map((update) => update.updateSeq)).toEqual([1, 2]);
  });

  // 多工具并行结束：每个终态实体都在自己的 final 批里移出运行态，重建后运行态为空、内容块描述符不重不漏。
  test("多工具并行结束后运行态无残留", async () => {
    const fixture = await setup("final-many");
    const tools = ["call-a", "call-b", "call-c", "call-d"];
    for (const toolCallId of tools) {
      await fixture.writer.accept(
        semantic("tool", { entityId: toolCallId, toolCallId, metadata: { status: "running" } }),
      );
    }
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId)).map((entity) => entity.entityId)).toEqual(tools);
    for (const toolCallId of [...tools].reverse()) {
      await fixture.writer.accept(finalOf(toolCallId, "tool"));
    }
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId))).toEqual([]);
    const finals = recordsOf(reconstruct(fixture, fixture.contentId)).filter((record) => record.kind === "final");
    expect(finals.map((record) => record.entryId).sort()).toEqual([...tools].sort());
  });

  // 长期等待的权限结束后同样不得残留：中间的正文写入不是删除的落库通道。
  test("长期等待的权限结束后运行态无残留", async () => {
    const fixture = await setup("final-permission");
    await fixture.writer.accept(semantic("permission", { entityId: "perm-wait", toolCallId: "call-a" }));
    await fixture.writer.accept({
      turnId: "turn-1",
      entryId: "entry-text",
      contentSlot: "text",
      contentType: "text/plain",
      kind: "text-delta",
      delta: "正文继续写入",
    });
    // 语义事件走屏障：先冲刷已接收的正文，再写本批次的语义切片。
    await fixture.writer.accept(finalOf("perm-wait", "permission"));

    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId))).toEqual([]);
    const records = recordsOf(reconstruct(fixture, fixture.contentId));
    expect(records.map((record) => record.kind).sort()).toEqual(["final", "text"]);
    expect(committedUpdates(fixture, fixture.runtimeId).map((update) => update.updateSeq)).toEqual([1, 2]);
  });

  // 封口后没有新写入：幽灵实体不得等到该 Doc 的下一次写入才消失（真实会话结束即长时间静默）。
  test("封口后无新写入时实体已清除", async () => {
    const fixture = await setup("final-seal");
    await fixture.writer.accept(semantic("tool", { entityId: "entity_p", toolCallId: "tc_p" }));
    await fixture.writer.accept(finalOf("entity_p", "tool"));
    const updatesBeforeSeal = committedUpdates(fixture, fixture.runtimeId).length;
    expect(updatesBeforeSeal).toBe(2);
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId))).toEqual([]);

    await fixture.writer.seal();

    expect(committedUpdates(fixture, fixture.runtimeId).length).toBe(updatesBeforeSeal);
    expect(entitiesOf(reconstruct(fixture, fixture.runtimeId))).toEqual([]);
  });
});
