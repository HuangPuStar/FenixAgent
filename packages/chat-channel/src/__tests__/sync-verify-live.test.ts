// packages/chat-channel/src/__tests__/sync-verify-live.test.ts
// D 阶段（`sync/live/*`）对抗验证复现文件：前四个 describe 是**确认缺陷的最小复现**（在交付版本上失败），
// 最后一个 describe 记录我验证过且未发现问题的关键边界。所有存储行为都跑在真实 `MemoryProjectionStore`
// 上（唯一注入是 `unknownOutcome` 委托：它先执行真实提交、再把返回值改写成「结果未知」，存储行为本身不被伪造）。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createMergeBuffer, type MergeFlushRequest, type MergeKey } from "../sync/live/merge-buffer";
import { createRotationController } from "../sync/live/rotation";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS, type RuntimeEntityRecord } from "../sync/live/runtime-doc";
import { createSealingMachine, type SealRequest } from "../sync/live/sealing";
import type { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { ProjectionStore, SyncDocRecord, WriterLease } from "../sync/store/types";

// ---------------------------------------------------------------- 基础设施

/** 注入式时钟：阈值与时序断言全部由它推进，不读真实时间。 */
class TestClock implements Clock {
  private current: number;
  constructor(current = 1_000) {
    this.current = current;
  }
  now(): number {
    return this.current;
  }
  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

const MERGE_KEY: MergeKey = {
  generation: "gen_1",
  turnId: "turn_1",
  entryId: "entry_1",
  contentSlot: "text",
  contentType: "text/plain",
};

const SCOPE: SyncScope = { organizationId: "org-1", rcsSessionId: "session-1" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen-1";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
const FIXED_CLOCK: Clock = { now: () => 1_000 };

/** 固定 clientID 的 Y.Doc：Yjs 默认随机 clientID，不固定则两次搭建得不到同一份字节。 */
function newYDoc(clientId: number): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientId;
  return doc;
}

function baseSnapshot(): Uint8Array {
  const doc = newYDoc(1);
  doc.getText("body").insert(0, "base");
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function emptyState(): Uint8Array {
  const doc = newYDoc(2);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function tailUpdates(base: Uint8Array, fragments: readonly string[], clientId = 3): Uint8Array[] {
  const doc = newYDoc(clientId);
  Y.applyUpdate(doc, base);
  const text = doc.getText("body");
  const updates: Uint8Array[] = [];
  for (const fragment of fragments) {
    const before = Y.encodeStateVector(doc);
    text.insert(text.length, fragment);
    updates.push(Y.encodeStateAsUpdate(doc, before));
  }
  doc.destroy();
  return updates;
}

function replay(base: Uint8Array, updates: readonly Uint8Array[]): Uint8Array {
  const doc = newYDoc(4);
  Y.applyUpdate(doc, base);
  for (const update of updates) Y.applyUpdate(doc, update);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function makeStore(): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock: FIXED_CLOCK,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
}

function docIdOf(nonce: string): string {
  return buildDocId({ kind: "runtime", generation: GENERATION, blockIndex: 0, nonce });
}

function docRecord(targetDocId: string, snapshot: Uint8Array, scopedKey = SCOPE_KEY): SyncDocRecord {
  return {
    scopeKey: scopedKey,
    generation: GENERATION,
    docId: targetDocId,
    kind: "runtime",
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

interface Fixture {
  store: MemoryProjectionStore;
  lease: WriterLease;
  predecessorDocId: string;
  successorDocId: string;
  base: Uint8Array;
  updates: Uint8Array[];
  finalUpdateSeq: number;
}

/** 已提交谱系：可写的 active 前驱（base 0 + 连续 tail）与预分配的 successor 身份。 */
async function setup(fragments: readonly string[] = ["one", "two"]): Promise<Fixture> {
  const store = makeStore();
  const lease = await store.acquireWriter(SCOPE_KEY, "writer-a", 60_000);
  await store.createGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    generation: {
      scopeKey: SCOPE_KEY,
      generation: GENERATION,
      acpSessionId: "acp-session-1",
      loadId: "load-1",
      state: "staging",
      importEndOrdinal: null,
      entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: "runtime", contentDocIds: [] },
      createdAt: 1_000,
    },
  });
  const predecessorDocId = docIdOf("a");
  const successorDocId = docIdOf("b");
  const base = baseSnapshot();
  await store.createDoc({ scopeKey: SCOPE_KEY, epoch: lease.epoch, doc: docRecord(predecessorDocId, base) });
  const updates = tailUpdates(base, fragments);
  const result = await store.appendUpdates({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "batch-1",
    digest: "batch-digest-1",
    expectedFrontiers: [{ docId: predecessorDocId, lastSeq: 0 }],
    updates: updates.map((bytes, index) => ({ docId: predecessorDocId, fromSeq: index + 1, bytes })),
  });
  if (result.outcome !== "committed") throw new Error(`tail append did not commit: ${result.outcome}`);
  return { store, lease, predecessorDocId, successorDocId, base, updates, finalUpdateSeq: result.frontiers[0].lastSeq };
}

/** 第 2 步之后崩溃的现场：successor 已预分配、路由已登记，前驱仍未封口。 */
async function crashedAfterStepTwo(fixture: Fixture): Promise<Fixture> {
  await fixture.store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: fixture.lease.epoch,
    doc: docRecord(fixture.successorDocId, emptyState()),
  });
  await fixture.store.registerSuccessor({
    scopeKey: SCOPE_KEY,
    epoch: fixture.lease.epoch,
    predecessorDocId: fixture.predecessorDocId,
    successorDocId: fixture.successorDocId,
    expectedLastSeq: fixture.finalUpdateSeq,
  });
  return fixture;
}

function machineFor(store: ProjectionStore) {
  return createSealingMachine({
    store,
    clock: FIXED_CLOCK,
    digest: sha256Digest,
    random: deterministicRandomSource("verify-live"),
  });
}

function sealRequest(fixture: Fixture, overrides: Partial<SealRequest> = {}): SealRequest {
  return {
    scope: SCOPE,
    oldDocId: fixture.predecessorDocId,
    lease: fixture.lease,
    finalUpdateSeq: fixture.finalUpdateSeq,
    successorDocId: fixture.successorDocId,
    successorInitialState: emptyState(),
    ...overrides,
  };
}

// ---------------------------------------------------------------- 缺陷复现

describe("缺陷复现：sealing 第 2 步没有「停止旧 Doc 写入」的承载物（设计 §7 第 2 步）", () => {
  // 设计 §7 第 2 步要求写入路由事务登记 `oldDoc.sealing(finalSeq)` 并停止旧 Doc 新写入。
  // 实现只登记了 successor 路由：旧 Doc 的 state 仍是 active，存储的写路径（appendUpdates → assertWritableDoc）
  // 只检查 state !== "active"，因此路由登记之后旧 Doc 依旧接受写入。
  test("第 2 步登记路由后，旧 Doc 必须拒绝新写入", async () => {
    const fixture = await setup(["one"]);
    await crashedAfterStepTwo(fixture);

    // 结果未知的批次在路由登记之后落地：这是设计 §7 第 1 步明确要求先结清的场景。
    const extra = tailUpdates(replay(fixture.base, fixture.updates), ["extra"], 7);
    const appended = fixture.store.appendUpdates({
      scopeKey: SCOPE_KEY,
      epoch: fixture.lease.epoch,
      owner: fixture.lease.owner,
      batchId: "batch-2",
      digest: "batch-digest-2",
      expectedFrontiers: [{ docId: fixture.predecessorDocId, lastSeq: fixture.finalUpdateSeq }],
      updates: [{ docId: fixture.predecessorDocId, fromSeq: fixture.finalUpdateSeq + 1, bytes: extra[0]! }],
    });

    // 修复前实际：committed，前沿从 1 推进到 2（已登记的截止序号被越过）
    await expect(appended).rejects.toThrow();
  });

  // 原缺陷的第二段：前沿越过登记的截止序号后，路由被钉死（DUPLICATE_OBJECT）而存储没有改写入口，谱系永久卡死。
  // D1 修复后该现场不可达——路由事务把前驱钉进 `sealing`，`appendUpdates` 在写前按 `state !== "active"` 拒绝
  // 任何续写（memory-store.ts 的 appendUpdates，唯一的 `doc.lastSeq` 写入口），前沿不可能再越过截止序号。
  // 因此这里断言新的不变量：越界写入被拒、谱系终点等于登记时的截止序号、崩溃后仍能按同一截序号封口。
  test("路由登记即钉死前沿：越界追加被拒，谱系仍可按登记的截止序号封口", async () => {
    const fixture = await setup(["one"]);
    await crashedAfterStepTwo(fixture);
    const extra = tailUpdates(replay(fixture.base, fixture.updates), ["extra"], 7);
    const beyond = fixture.store.appendUpdates({
      scopeKey: SCOPE_KEY,
      epoch: fixture.lease.epoch,
      owner: fixture.lease.owner,
      batchId: "batch-2",
      digest: "batch-digest-2",
      expectedFrontiers: [{ docId: fixture.predecessorDocId, lastSeq: fixture.finalUpdateSeq }],
      updates: [{ docId: fixture.predecessorDocId, fromSeq: fixture.finalUpdateSeq + 1, bytes: extra[0]! }],
    });
    await expect(beyond).rejects.toMatchObject({ code: "RESOURCE_RETIRED" });

    // 新进程：只带走已提交状态，旧写者的内存与租约都不存在。
    const restarted = makeStore();
    restarted.restoreFromCommittedState(fixture.store.exportCommittedState());
    const lease = await restarted.acquireWriter(SCOPE_KEY, "writer-b", 60_000);
    const machine = machineFor(restarted);

    // 崩溃恢复产物：谱系终点是登记时钉死的截止序号，不是被拒写入的序号。
    const recovered = await machine.recover(fixture.predecessorDocId);
    expect(recovered?.finalUpdateSeq).toBe(fixture.finalUpdateSeq);

    // 按同一截止序号完成封口：路由与封口事务都幂等，收尾不需要改写路由。
    const sealed = await machine.seal({
      scope: SCOPE,
      oldDocId: fixture.predecessorDocId,
      lease,
      finalUpdateSeq: fixture.finalUpdateSeq,
      successorDocId: fixture.successorDocId,
      successorInitialState: emptyState(),
    });
    expect(sealed.finalUpdateSeq).toBe(fixture.finalUpdateSeq);
    expect((await restarted.readDocStateAt(fixture.predecessorDocId, fixture.finalUpdateSeq))?.hash).toBe(
      sealed.snapshotDigest,
    );
  });

  // 同一根因的第二种触发方式，且不需要崩溃：一批真实写入落在「登记路由」与「封口提交」之间。修复后它不再
  // 制造「越过截止序号的前沿」，而是在存储里被直接拒绝——封口窗口内没有第三方写入能改变谱系终点。
  // Proxy 只负责调度那次真实 appendUpdates，其余读写与提交仍全部落在真实存储上。
  test("封口窗口内的迟到写入被拒，封口按登记的截止序号一次提交", async () => {
    const fixture = await setup(["one"]);
    let injected = false;
    const lateWrites: string[] = [];
    const intercepting = new Proxy(fixture.store, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          const settled = method.apply(source, args);
          if (String(property) !== "registerSuccessor" || injected) return settled;
          injected = true;
          return Promise.resolve(settled).then(async (outcome) => {
            const extra = tailUpdates(replay(fixture.base, fixture.updates), ["extra"], 9);
            try {
              await fixture.store.appendUpdates({
                scopeKey: SCOPE_KEY,
                epoch: fixture.lease.epoch,
                owner: fixture.lease.owner,
                batchId: "late-batch",
                digest: "late-digest",
                expectedFrontiers: [{ docId: fixture.predecessorDocId, lastSeq: fixture.finalUpdateSeq }],
                updates: [{ docId: fixture.predecessorDocId, fromSeq: fixture.finalUpdateSeq + 1, bytes: extra[0]! }],
              });
              lateWrites.push("committed");
            } catch (error) {
              lateWrites.push((error as SyncProtocolError).code);
            }
            return outcome;
          });
        };
      },
    }) as unknown as ProjectionStore;

    const machine = machineFor(intercepting);
    // 设计 §7 把「封口可收尾」当作保证：第一次封口即按登记的截止序号提交成功。
    const sealed = await machine.seal(sealRequest(fixture));
    expect(lateWrites).toEqual(["RESOURCE_RETIRED"]);
    expect(sealed.finalUpdateSeq).toBe(fixture.finalUpdateSeq);
    expect(machine.phase).toBe("sealed");

    // 新进程：只带走已提交状态，恢复出的谱系终点与封口结果一致。
    const restarted = makeStore();
    restarted.restoreFromCommittedState(fixture.store.exportCommittedState());
    const recovered = await machineFor(restarted).recover(fixture.predecessorDocId);
    expect(recovered?.finalUpdateSeq).toBe(fixture.finalUpdateSeq);
    expect(recovered?.snapshotDigest).toBe(sealed.snapshotDigest);
  });
});

describe("缺陷复现：sealing 计划缓存不含 scope（设计 §4.1 身份不可混用）", () => {
  // `plan()` 用 docId 单键缓存计划，缓存命中路径不再校验请求的 scope/lease。同一台机器被复用到另一个 scope 时，
  // 第二个请求会拿到第一个 scope 的结果：既没有任何存储写入，也没有任何错误。
  test("请求的 scope 内没有该 Doc 时不得返回其他 scope 的成功结果", async () => {
    const fixture = await setup(["one"]);
    const machine = machineFor(fixture.store);
    const first = await machine.seal(sealRequest(fixture));
    expect(first.finalUpdateSeq).toBe(fixture.finalUpdateSeq);

    const otherScope: SyncScope = { organizationId: "org-2", rcsSessionId: "session-9" };
    const otherScopeKey = scopeKey(otherScope);
    const otherLease = await fixture.store.acquireWriter(otherScopeKey, "writer-x", 60_000);

    let resolvedDigest: string | null = null;
    try {
      const second = await machine.seal({
        scope: otherScope,
        oldDocId: fixture.predecessorDocId, // 该 scope 内根本没有这个 Doc
        lease: otherLease,
        finalUpdateSeq: fixture.finalUpdateSeq,
        successorDocId: fixture.successorDocId,
        successorInitialState: emptyState(),
      });
      resolvedDigest = second.snapshotDigest;
    } catch {
      resolvedDigest = null;
    }

    // 修复前实际：解析出 org-1 的摘要（跨 scope 假成功）
    expect(resolvedDigest).toBeNull();
    // 反证：请求 scope 的指针从未被推进，说明成功结果背后没有任何本 scope 的已提交状态
    expect((await fixture.store.readScopePointer(otherScopeKey))?.pointerRevision).toBe(0);
  });
});

describe("缺陷复现：merge-buffer onFlush 回调内重入 push 会劫持目标缓冲（设计 §6.1）", () => {
  // 设计 §6.1：只合并键完全相同的连续文本增量。`push()` 先冲刷、再从 `pending` 取目标缓冲；
  // 冲刷回调内重入 `push()` 会把 `pending` 换成另一个键的缓冲，外层增量随后被追加进那个缓冲，
  // 于是异键文本被并入同一条记录（内容串台），且原键的文本永远不会以自身键出现。
  test("重入 push 后，每条记录的文本必须只由该键接收到的增量组成", () => {
    const flushes: MergeFlushRequest[] = [];
    const keyReasoning: MergeKey = { ...MERGE_KEY, contentSlot: "reasoning" };
    const keyOther: MergeKey = { ...MERGE_KEY, contentSlot: "other" };
    let reentered = false;
    const buffer = createMergeBuffer({
      clock: new TestClock(),
      maxDelayMs: 100_000,
      maxBytes: 1_000_000,
      onFlush: (request) => {
        flushes.push(request);
        if (!reentered) {
          reentered = true;
          buffer.push(keyOther, "C");
        }
      },
    });

    buffer.push(MERGE_KEY, "A");
    buffer.push(keyReasoning, "B"); // 键不同 → 先冲刷 text 键；回调内重入 push 打开 other 键窗口
    buffer.flushAll();

    const textBySlot = new Map<string, string>();
    for (const request of flushes) {
      textBySlot.set(request.key.contentSlot, (textBySlot.get(request.key.contentSlot) ?? "") + request.text);
    }
    // 修复前实际：{ text: "A", other: "CB" } —— reasoning 键的 "B" 被写进了 other 键
    expect(Object.fromEntries(textBySlot)).toEqual({ text: "A", reasoning: "B", other: "C" });
  });
});

describe("缺陷复现：runtime-doc 允许 final → open 静默丢弃终态描述符（设计 §6.2）", () => {
  // 设计 §6.2：实体完成时 final record、固定大小终态描述符与定位索引同事务持久化，索引提交后才允许移除；
  // 运行态中留在文档里的终态描述符是「交接未完成」的唯一证据（§6.3 轮换要把它复制过去）。
  // `upsertEntity` 只校验 open⇒无描述符 / final⇒有描述符，未阻止 final → open 回退：
  // 描述符被无声替换掉，轮换导出随之丢失交接信息（重放或乱序到达的 provisional 更新即触发）。
  test("已 final 的实体被 open 覆盖后，轮换导出必须仍携带终态描述符", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    const finalRecord: RuntimeEntityRecord = {
      entityId: "e-1",
      kind: "tool",
      metadata: { result: "ok" },
      state: "final",
      finalDescriptor: {
        entityId: "e-1",
        kind: "tool",
        contentRef: "content/e-1",
        digest: "a".repeat(64),
        byteLength: 4096,
        completedAt: 1_000,
      },
    };
    doc.upsertEntity(finalRecord);
    // 乱序/重放：同一实体的 provisional 更新在 final 之后到达
    doc.upsertEntity({ entityId: "e-1", kind: "tool", metadata: { result: "ok" }, state: "open" });

    const exported = doc.exportForRotation().find((record) => record.entityId === "e-1");
    // 修复前实际：finalDescriptor 为 undefined（与 removeEntity 返回 null 相互印证），终态描述符已被静默丢弃
    expect(exported?.finalDescriptor).toBeDefined();
  });
});

describe("缺陷复现：runtime-doc 不校验注入的容量参数（NaN 静默关闭上限）", () => {
  // 三处容量上限（实体数 / 元数据 / 存活载荷）都靠数值比较，NaN 会让比较恒为 false 从而全部失效；
  // merge-buffer 与 rotation 都在构造期拒绝非法参数（ADMISSION_REJECTED），runtime-doc 是唯一例外。
  // 修复前实测：maxEntities=NaN 时 300 个实体全部接受，maxLivePayloadBytes=maxEntityMetadataBytes=NaN 时 5KiB 元数据被接受。
  test("非法容量参数必须在构造期被拒（与 merge-buffer / rotation 同口径）", () => {
    expect(() => createRuntimeDoc("runtime", { ...RUNTIME_DOC_LIMITS, maxEntities: Number.NaN })).toThrow();
    expect(() =>
      createRuntimeDoc("runtime", {
        ...RUNTIME_DOC_LIMITS,
        maxLivePayloadBytes: Number.NaN,
        maxEntityMetadataBytes: Number.NaN,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------- 已核验边界（应通过）

describe("已核验边界：merge-buffer / runtime-doc / rotation", () => {
  // 时间阈值从首增量起算：真实定时器在窗口结束后提交，后续增量不重设定时器（非 trailing debounce）。
  test("定时器从首增量起算，后续增量不推迟提交", async () => {
    const flushes: MergeFlushRequest[] = [];
    const buffer = createMergeBuffer({
      clock: new TestClock(),
      maxDelayMs: 10,
      maxBytes: 1_000_000,
      onFlush: (request) => flushes.push(request),
    });
    buffer.push(MERGE_KEY, "a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    buffer.push(MERGE_KEY, "b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushes.map((request) => request.text)).toEqual(["a", "b"]);
    buffer.dispose();
  });

  // 键切换先冲刷旧键（旧文本不丢、不跨键合并），屏障对同键幂等且同步可完成。
  test("键切换先冲刷旧键，屏障幂等且不冲刷异键缓冲", () => {
    const flushes: MergeFlushRequest[] = [];
    const buffer = createMergeBuffer({
      clock: new TestClock(),
      maxDelayMs: 100_000,
      maxBytes: 1_000_000,
      onFlush: (request) => flushes.push(request),
    });
    buffer.push(MERGE_KEY, "A");
    buffer.push({ ...MERGE_KEY, turnId: "turn_2" }, "B");
    expect(flushes.map((request) => [request.key.turnId, request.text])).toEqual([["turn_1", "A"]]);
    buffer.barrier({ ...MERGE_KEY, turnId: "turn_2" });
    buffer.barrier({ ...MERGE_KEY, turnId: "turn_2" });
    expect(flushes.map((request) => [request.key.turnId, request.text])).toEqual([
      ["turn_1", "A"],
      ["turn_2", "B"],
    ]);
    expect(buffer.pendingKeys()).toBe(0);
    buffer.dispose();
  });

  // 真实 64KiB 存活载荷边界：恰好 65536 字节被接受，+1 字节被拒且实现自报的 required 正是 65537。
  test("存活载荷恰好 64KiB 通过、+1 字节被拒", () => {
    const limit = RUNTIME_DOC_LIMITS.maxLivePayloadBytes;
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    const encoder = new TextEncoder();
    const entityId = (index: number) => `e-${String(index).padStart(4, "0")}`;
    const recordOf = (index: number, pad: number): RuntimeEntityRecord => ({
      entityId: entityId(index),
      kind: "tool",
      toolCallId: `c-${index}`,
      metadata: { pad: "x".repeat(Math.max(0, pad - 10)) },
      state: "open",
    });
    // 与实现同构的投影（键顺序一致）：pad ≥ 10 时 metadata 的 JSON 长度恰好等于 pad
    const sizeOf = (index: number, pad: number) =>
      encoder.encode(
        JSON.stringify({
          entityId: entityId(index),
          kind: "tool",
          metadata: { pad: "x".repeat(Math.max(0, pad - 10)) },
          state: "open",
          toolCallId: `c-${index}`,
        }),
      ).length;
    const baseOf = (index: number) => sizeOf(index, 10); // pad = 10 → metadata 为空串

    let index = 0;
    let used = 0;
    while (used + sizeOf(index, 1024) <= limit) {
      doc.upsertEntity(recordOf(index, 1024));
      used += sizeOf(index, 1024);
      index += 1;
    }
    // 尾实体用可调 pad 精确落到上限；余量不足时把最后一条整尺寸实体缩掉，垫出可调区间
    let remaining = limit - used;
    if (remaining < baseOf(index)) {
      const free = baseOf(index) - remaining;
      doc.upsertEntity(recordOf(index - 1, 1024 - free));
      used -= free;
      remaining = limit - used;
    }
    const pad = remaining - baseOf(index) + 10;
    expect(pad).toBeGreaterThanOrEqual(10);
    expect(pad).toBeLessThanOrEqual(1024);
    expect(sizeOf(index, pad)).toBe(limit - used);

    doc.upsertEntity(recordOf(index, pad)); // 恰好达标：接受

    let reported = "";
    try {
      doc.upsertEntity(recordOf(index, pad + 1)); // 上限 +1：拒绝
    } catch (error) {
      reported = (error as SyncProtocolError).message;
    }
    expect(reported).toContain(`reach ${limit + 1} bytes`);
  });

  // 实体数 256 / 元数据 1KiB 的上限 +1 被拒；替换导致的超限被拒且旧实体（含终态描述符）保留。
  test("实体数与元数据上限 +1 被拒，超限替换不破坏旧实体", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    const open = (index: number, pad: number): RuntimeEntityRecord => ({
      entityId: `n-${String(index).padStart(4, "0")}`,
      kind: "tool",
      metadata: { pad: "x".repeat(Math.max(0, pad - 10)) },
      state: "open",
    });
    doc.upsertEntity(open(0, 1024));
    expect(() => doc.upsertEntity(open(1, 1025))).toThrow();
    for (let index = 1; index < 256; index += 1) doc.upsertEntity(open(index, 10));
    expect(doc.entityCount()).toBe(256);
    expect(() => doc.upsertEntity(open(256, 10))).toThrow();
    // 更新已有实体不受实体数上限限制
    doc.upsertEntity(open(0, 1024));
    expect(doc.entityCount()).toBe(256);
  });

  // 轮换三个理由的阈值：恰好达标触发、差 1 不触发；优先级 size-soft → deadline → transaction-count；reset 归零。
  test("轮换阈值恰好达标触发且优先级固定", () => {
    const clock = new TestClock(1_000);
    const rotation = createRotationController({
      clock,
      random: deterministicRandomSource("verify"),
      limits: RUNTIME_DOC_LIMITS,
      maxResidentMs: 10,
      maxTransactions: 3,
    });
    expect(rotation.evaluate({ encodedBytes: RUNTIME_DOC_LIMITS.softRotateBytes - 1, entityCount: 1 })).toEqual({
      rotate: false,
    });
    expect(rotation.evaluate({ encodedBytes: RUNTIME_DOC_LIMITS.softRotateBytes, entityCount: 1 })).toEqual({
      rotate: true,
      reason: "size-soft",
    });
    clock.advance(9);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 0 })).toEqual({ rotate: false });
    clock.advance(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 0 })).toEqual({ rotate: true, reason: "deadline" });
    rotation.onTransaction(1);
    rotation.onTransaction(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 0 })).toEqual({ rotate: true, reason: "deadline" });
    rotation.reset();
    rotation.onTransaction(1);
    rotation.onTransaction(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 0 })).toEqual({ rotate: false });
    rotation.onTransaction(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 0 })).toEqual({
      rotate: true,
      reason: "transaction-count",
    });
  });
});

describe("已核验边界：sealing", () => {
  // 第 2 步的前沿校验在存储的同步提交段内：本机读到的连续区间满足要求、存储前沿领先时被拒，且不留半步路由。
  test("路由事务用存储内的当前前沿复核截止序号", async () => {
    const fixture = await setup();
    const machine = machineFor(fixture.store);
    await expect(machine.seal(sealRequest(fixture, { finalUpdateSeq: 1 }))).rejects.toMatchObject({
      code: "SEQUENCE_GAP",
    });
    expect(machine.phase).toBe("failed");
    expect(await fixture.store.readDocStateAt(fixture.predecessorDocId, 1)).toBeNull();
    expect(
      await fixture.store.registerSuccessor({
        scopeKey: SCOPE_KEY,
        epoch: fixture.lease.epoch,
        predecessorDocId: fixture.predecessorDocId,
        successorDocId: fixture.successorDocId,
        expectedLastSeq: fixture.finalUpdateSeq,
      }),
    ).toEqual({ outcome: "committed" });
  });

  // 结果未知先查询：封口实际已提交时，本机凭「截止序号处已封口且摘要一致」确认为成功，不重放副作用。
  test("sealDoc 报 unknown 但实际已提交时确认为成功", async () => {
    const fixture = await setup(["one"]);
    let sealDocCalls = 0;
    const store = new Proxy(fixture.store, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          if (String(property) === "sealDoc") {
            sealDocCalls += 1;
            if (sealDocCalls === 1) {
              const real = method.apply(source, args) as Promise<{ outcome: string }>;
              return real.then(() => ({ outcome: "unknown", finalSeq: fixture.finalUpdateSeq }));
            }
          }
          return method.apply(source, args);
        };
      },
    }) as unknown as ProjectionStore;

    const result = await machineFor(store).seal(sealRequest(fixture));
    expect(result.finalUpdateSeq).toBe(fixture.finalUpdateSeq);
    expect(sealDocCalls).toBe(1);
    expect((await fixture.store.readDocStateAt(fixture.predecessorDocId, fixture.finalUpdateSeq))?.hash).toBe(
      result.snapshotDigest,
    );
  });

  // 崩溃恢复不依赖旧写者内存：新 store 实例（只带走已提交状态）+ 300 条跨分页 tail，重建摘要与封口路径一致。
  test("新实例按已提交 tail 重建同一摘要（跨分页）", async () => {
    const fixture = await setup(Array.from({ length: 300 }, (_, index) => `f${index}`));
    const sealed = await machineFor(fixture.store).seal(sealRequest(fixture));
    const restarted = makeStore();
    restarted.restoreFromCommittedState(fixture.store.exportCommittedState());
    const recovered = await machineFor(restarted).recover(fixture.predecessorDocId);
    expect(recovered?.finalUpdateSeq).toBe(fixture.finalUpdateSeq);
    expect(recovered?.snapshotDigest).toBe(sealed.snapshotDigest);
    expect(recovered?.stateVector).toEqual(sealed.stateVector);
    expect(recovered?.encodedLength).toBe(sealed.encodedLength);
  });

  // 同摘要重复封口幂等且复用同一份字节；异摘要已提交时判 DIGEST_CONFLICT 且只尝试一次 sealDoc。
  test("同摘要幂等、异摘要停写", async () => {
    const fixture = await setup(["one"]);
    const machine = machineFor(fixture.store);
    const first = await machine.seal(sealRequest(fixture));
    const second = await machine.seal(sealRequest(fixture));
    expect(second.snapshotDigest).toBe(first.snapshotDigest);
    expect(second.stateVector).toEqual(first.stateVector);

    const other = await setup(["one"]);
    await other.store.createDoc({
      scopeKey: SCOPE_KEY,
      epoch: other.lease.epoch,
      doc: docRecord(other.successorDocId, emptyState()),
    });
    await other.store.registerSuccessor({
      scopeKey: SCOPE_KEY,
      epoch: other.lease.epoch,
      predecessorDocId: other.predecessorDocId,
      successorDocId: other.successorDocId,
      expectedLastSeq: other.finalUpdateSeq,
    });
    const committedBytes = replay(other.base, other.updates);
    const foreignBytes = replay(committedBytes, tailUpdates(committedBytes, ["foreign"], 6));
    await other.store.sealDoc({
      scopeKey: SCOPE_KEY,
      epoch: other.lease.epoch,
      expectedLastSeq: other.finalUpdateSeq,
      docId: other.predecessorDocId,
      finalSnapshot: foreignBytes,
      finalHash: sha256Digest(foreignBytes),
      successorDocId: other.successorDocId,
      manifestChange: { activeDocId: other.successorDocId },
    });
    let sealDocCalls = 0;
    const counting = new Proxy(other.store, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          if (String(property) === "sealDoc") sealDocCalls += 1;
          return method.apply(source, args);
        };
      },
    }) as unknown as ProjectionStore;
    const conflicting = machineFor(counting);
    await expect(conflicting.seal(sealRequest(other))).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
    expect(conflicting.phase).toBe("failed");
    expect(sealDocCalls).toBe(1);
    expect((await other.store.readDocStateAt(other.predecessorDocId, other.finalUpdateSeq))?.hash).toBe(
      sha256Digest(foreignBytes),
    );
  });

  // 封口成功后：旧 Doc 拒绝追加（RESOURCE_RETIRED）、successor 已登记且其初始字节不可被调用方改写。
  test("封口后旧 Doc 停写、successor 身份与字节固定", async () => {
    const fixture = await setup(["one"]);
    const machine = machineFor(fixture.store);
    const request = sealRequest(fixture);
    const result = await machine.seal(request);
    expect(machine.phase).toBe("sealed");

    await expect(
      fixture.store.appendUpdates({
        scopeKey: SCOPE_KEY,
        epoch: fixture.lease.epoch,
        owner: fixture.lease.owner,
        batchId: "batch-2",
        digest: "batch-digest-2",
        expectedFrontiers: [{ docId: fixture.predecessorDocId, lastSeq: fixture.finalUpdateSeq }],
        updates: [{ docId: fixture.predecessorDocId, fromSeq: fixture.finalUpdateSeq + 1, bytes: emptyState() }],
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_RETIRED" });

    expect(
      await fixture.store.registerSuccessor({
        scopeKey: SCOPE_KEY,
        epoch: fixture.lease.epoch,
        predecessorDocId: fixture.predecessorDocId,
        successorDocId: fixture.successorDocId,
        expectedLastSeq: fixture.finalUpdateSeq,
      }),
    ).toEqual({ outcome: "already-committed" });
    request.successorInitialState.fill(0);
    expect((await fixture.store.readDocStateAt(fixture.successorDocId, 0))?.snapshot).toEqual(emptyState());
    expect((await fixture.store.readDocStateAt(fixture.predecessorDocId, fixture.finalUpdateSeq))?.hash).toBe(
      result.snapshotDigest,
    );
  });
});
