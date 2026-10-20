import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, type DigestFn, sha256Digest } from "../sync/clock";
import { type BasePlanRequest, createBasePlanner } from "../sync/provider/base-plan";
import { createTailPlanner } from "../sync/provider/tail-plan";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { ProjectionStore, SyncDocRecord, SyncGenerationRecord, WriterLease } from "../sync/store/types";

const SCOPE = "org-1/session-1";
const GENERATION = "gen-1";
const DOC_ID = "gen-1-runtime-1";
const SUCCESSOR_DOC_ID = "gen-1-runtime-2";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;

class TestClock implements Clock {
  private current = 1_000;

  now(): number {
    return this.current;
  }
}

function makeStore(clock: Clock): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
}

/** 记录调用次序的代理：断言规划只经只读出口取值，不触碰任何写入原语。 */
function recordingStore(inner: MemoryProjectionStore): { store: ProjectionStore; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

/**
 * 故意破坏「遇缺口即停」契约的读侧：按 `updateSeq > seq` 查询（SQL adapter 的写法）把缺口之后的记录也返回，
 * 用于固定规划层对越界记录的复核行为——契约层面不该出现，但保留边界回收后现网可达。
 */
function gapCrossingStore(inner: MemoryProjectionStore, skipped: readonly number[]): ProjectionStore {
  const skippedSeqs = new Set(skipped);
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "readUpdatesAfter") {
        return async (docId: string, seq: number, limit: number) => {
          const all = await target.readUpdatesAfter(docId, 0, Number.MAX_SAFE_INTEGER);
          return all.filter((record) => record.updateSeq > seq && !skippedSeqs.has(record.updateSeq)).slice(0, limit);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function generationRecord(): SyncGenerationRecord {
  return {
    scopeKey: SCOPE,
    generation: GENERATION,
    acpSessionId: "acp-session",
    loadId: "load-1",
    state: "staging",
    importEndOrdinal: null,
    entryRefs: {
      controlDocId: "gen-1-control",
      directoryDocId: "gen-1-directory",
      runtimeDocId: DOC_ID,
      contentDocIds: [],
    },
    createdAt: 1_000,
  };
}

function docRecord(docId: string, snapshot: Uint8Array): SyncDocRecord {
  return {
    scopeKey: SCOPE,
    generation: GENERATION,
    docId,
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

/** 测试用编辑脚本：append 追加文本、remove 删除前缀（覆盖 delete-set 与多结构场景）。 */
type EditStep =
  | { readonly kind: "append"; readonly text: string }
  | { readonly kind: "remove"; readonly length: number };

interface SeededSession {
  readonly store: MemoryProjectionStore;
  readonly clock: TestClock;
  readonly lease: WriterLease;
  /** 服务端 @S 的等价物：canonical 基线 + 逐条已提交更新的真实 Yjs 状态。 */
  readonly serverDoc: Y.Doc;
  readonly snapshot: Uint8Array;
  readonly updates: Uint8Array[];
}

/** 造出「基线快照 + 连续已提交更新」：每条更新的字节与 store 中 appends 的字节完全一致。 */
async function seedSession(steps: readonly EditStep[] = []): Promise<SeededSession> {
  const clock = new TestClock();
  const store = makeStore(clock);
  const lease = await store.acquireWriter(SCOPE, "writer-a", 60_000);
  await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord() });

  const serverDoc = new Y.Doc();
  serverDoc.getText("t").insert(0, "base");
  const snapshot = Y.encodeStateAsUpdate(serverDoc);
  await store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: docRecord(DOC_ID, snapshot) });

  const updates: Uint8Array[] = [];
  let frontier = 0;
  let stateVector = Y.encodeStateVector(serverDoc);
  for (const step of steps) {
    const text = serverDoc.getText("t");
    if (step.kind === "append") text.insert(text.length, step.text);
    else text.delete(0, step.length);
    const update = Y.encodeStateAsUpdate(serverDoc, stateVector);
    stateVector = Y.encodeStateVector(serverDoc);
    updates.push(update);
    frontier += 1;
    await store.appendUpdates({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      owner: lease.owner,
      batchId: `batch-${frontier}`,
      digest: `digest-${frontier}`,
      expectedFrontiers: [{ docId: DOC_ID, lastSeq: frontier - 1 }],
      updates: [{ docId: DOC_ID, fromSeq: frontier, bytes: update }],
    });
  }
  return { store, clock, lease, serverDoc, snapshot, updates };
}

function baseRequest(overrides: Partial<BasePlanRequest> = {}): BasePlanRequest {
  return {
    docId: DOC_ID,
    generation: GENERATION,
    subscriptionEpoch: "sub-epoch-1",
    syncAttemptId: "attempt-1",
    ...overrides,
  };
}

function applyToFreshDoc(payload: Uint8Array | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (payload !== undefined) Y.applyUpdate(doc, payload);
  return doc;
}

describe("BasePlanner", () => {
  // 未确认可信基线时必须整体下发完整 snapshot，且截止序号停在连续已提交前沿。
  test("无可信基线时产出完整 snapshot 并停在连续已提交前沿", async () => {
    const { store, serverDoc } = await seedSession([
      { kind: "append", text: " one" },
      { kind: "append", text: " two" },
    ]);
    const planner = createBasePlanner({ store, digest: sha256Digest });

    const plan = await planner.plan(baseRequest());
    expect(plan?.mode).toBe("full");
    expect(plan?.docId).toBe(DOC_ID);
    expect(plan?.upToSeq).toBe(2);
    expect(plan?.encodedLength).toBe(plan?.payload.byteLength);

    const restored = applyToFreshDoc(plan?.payload);
    expect(Y.equalSnapshots(Y.snapshot(restored), Y.snapshot(serverDoc))).toBe(true);
    expect(restored.getText("t").toString()).toBe(serverDoc.getText("t").toString());
  });

  // 没有已提交更新时 base 就是基线快照本身，截止序号等于基线序号。
  test("基线为空时下发基线快照本身", async () => {
    const { store, serverDoc } = await seedSession();
    const planner = createBasePlanner({ store, digest: sha256Digest });

    const plan = await planner.plan(baseRequest());
    expect(plan?.mode).toBe("full");
    expect(plan?.upToSeq).toBe(0);
    const restored = applyToFreshDoc(plan?.payload);
    expect(Y.equalSnapshots(Y.snapshot(restored), Y.snapshot(serverDoc))).toBe(true);
  });

  // 有可信基线时才允许差分：返回字节由服务端状态 @S 算出，实际应用后必须与服务端等价（含 delete-set）。
  test("可信基线时产出差分且应用后与服务端状态等价", async () => {
    const { store, serverDoc, snapshot, updates } = await seedSession([
      { kind: "append", text: " one" },
      { kind: "remove", length: 4 },
      { kind: "append", text: " two" },
    ]);
    const planner = createBasePlanner({ store, digest: sha256Digest });
    const full = await planner.plan(baseRequest());

    // 客户端基线 = 基线快照 + 第 1 条更新；服务端随后删除 "base" 并追加 " two"。
    const client = applyToFreshDoc(snapshot);
    Y.applyUpdate(client, updates[0] ?? new Uint8Array());
    const plan = await planner.plan(baseRequest({ clientStateVector: Y.encodeStateVector(client) }));

    expect(plan?.mode).toBe("diff");
    expect(plan?.upToSeq).toBe(3);
    expect(plan?.encodedLength).toBeLessThan(full?.encodedLength ?? 0);
    Y.applyUpdate(client, plan?.payload ?? new Uint8Array());
    expect(client.getText("t").toString()).toBe(" one two");
    expect(Y.equalSnapshots(Y.snapshot(client), Y.snapshot(serverDoc))).toBe(true);
  });

  // 客户端已追平服务端时差分载荷为空结构集，仍必须返回一帧（不得因 SV 相等而省略或改判模式）。
  test("客户端已追平时仍返回差分载荷", async () => {
    const { store, serverDoc, snapshot, updates } = await seedSession([{ kind: "append", text: " one" }]);
    const planner = createBasePlanner({ store, digest: sha256Digest });

    const client = applyToFreshDoc(snapshot);
    Y.applyUpdate(client, updates[0] ?? new Uint8Array());
    const plan = await planner.plan(baseRequest({ clientStateVector: Y.encodeStateVector(client) }));

    expect(plan?.mode).toBe("diff");
    expect(plan?.payload.byteLength).toBeGreaterThan(0);
    Y.applyUpdate(client, plan?.payload ?? new Uint8Array());
    expect(Y.equalSnapshots(Y.snapshot(client), Y.snapshot(serverDoc))).toBe(true);
  });

  // 本地存在服务端未知结构（异实例/本地修改）时差分无法重建完整副本，必须回退完整 snapshot。
  test("本地存在服务端未知结构时回退完整 snapshot", async () => {
    const { store } = await seedSession([{ kind: "append", text: " one" }]);
    const planner = createBasePlanner({ store, digest: sha256Digest });

    const foreign = Y.encodeStateVector(new Map([[4_294_967_295, 7]]));
    const plan = await planner.plan(baseRequest({ clientStateVector: foreign }));
    expect(plan?.mode).toBe("full");
  });

  // 客户端时钟超前服务端（存在未定 apply 或更晚本地内容）同属不可信基线。
  test("客户端时钟超前时回退完整 snapshot", async () => {
    const { store, serverDoc } = await seedSession([{ kind: "append", text: " one" }]);
    const planner = createBasePlanner({ store, digest: sha256Digest });

    const serverState = Y.decodeStateVector(Y.encodeStateVector(serverDoc));
    const ahead = Y.encodeStateVector(new Map([[serverDoc.clientID, (serverState.get(serverDoc.clientID) ?? 0) + 1]]));
    const plan = await planner.plan(baseRequest({ clientStateVector: ahead }));
    expect(plan?.mode).toBe("full");
  });

  // 空字节、非法编码与超限向量都不是可信基线：按完整 snapshot 处理而不是让同步失败。
  test("空、非法与超限 state vector 回退完整 snapshot", async () => {
    const { store } = await seedSession([{ kind: "append", text: " one" }]);
    const planner = createBasePlanner({ store, digest: sha256Digest });

    const empty = await planner.plan(baseRequest({ clientStateVector: new Uint8Array(0) }));
    const malformed = await planner.plan(baseRequest({ clientStateVector: new Uint8Array([255, 255, 255, 1]) }));
    const oversized = await planner.plan(baseRequest({ clientStateVector: new Uint8Array(4_097).fill(3) }));

    expect([empty?.mode, malformed?.mode, oversized?.mode]).toEqual(["full", "full", "full"]);
  });

  // 摘要只校验传输字节：既不参与「基线等价」判定，也不等于 canonical snapshot 的存储摘要。
  test("摘要只覆盖返回的传输字节", async () => {
    const { store, snapshot, updates } = await seedSession([{ kind: "append", text: " one" }]);
    const seen: Uint8Array[] = [];
    const digest: DigestFn = (bytes) => {
      seen.push(bytes);
      return `len:${bytes.byteLength}`;
    };
    const planner = createBasePlanner({ store, digest });

    const client = applyToFreshDoc(snapshot);
    Y.applyUpdate(client, updates[0] ?? new Uint8Array());
    const plan = await planner.plan(baseRequest({ clientStateVector: Y.encodeStateVector(client) }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(plan?.payload);
    expect(plan?.digest).toBe(`len:${plan?.payload.byteLength ?? -1}`);
    expect(plan?.digest).not.toBe(sha256Digest(snapshot));
  });

  // base 规划必须只经存储的只读出口取值，不得绕开原语直接读内存状态。
  test("base 规划只使用 readDocStateAt 与 readUpdatesAfter", async () => {
    const { store } = await seedSession([{ kind: "append", text: " one" }]);
    const { store: recording, calls } = recordingStore(store);
    const planner = createBasePlanner({ store: recording, digest: sha256Digest });

    await planner.plan(baseRequest());
    expect(new Set(calls)).toEqual(new Set(["readDocStateAt", "readUpdatesAfter"]));
  });

  // 未知 Doc 没有任何已提交状态可读：返回 null，由调用方换 Doc 或换代次，而不是猜一份空快照。
  test("未知 Doc 返回 null", async () => {
    const { store } = await seedSession([{ kind: "append", text: " one" }]);
    const planner = createBasePlanner({ store, digest: sha256Digest });

    expect(await planner.plan(baseRequest({ docId: "missing-doc" }))).toBeNull();
  });

  // 封口 Doc 的可读终态经 requestedFromSeq 指认后即为有界 base：尾部已回收时也不再依赖 update 链。
  test("requestedFromSeq 命中封口终态时以其为基线", async () => {
    const { store, clock, lease, serverDoc } = await seedSession([
      { kind: "append", text: " one" },
      { kind: "append", text: " two" },
    ]);
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: DOC_ID,
      successorDocId: SUCCESSOR_DOC_ID,
      expectedLastSeq: 2,
    });
    const finalSnapshot = Y.encodeStateAsUpdate(serverDoc);
    const sealed = await store.sealDoc({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedLastSeq: 2,
      docId: DOC_ID,
      finalSnapshot,
      finalHash: sha256Digest(finalSnapshot),
      successorDocId: SUCCESSOR_DOC_ID,
      manifestChange: {},
    });
    expect(sealed.finalSeq).toBe(2);

    // 封口宽限期后尾部被回收：只剩基线快照与封口快照可读。
    const exported = store.exportCommittedState();
    const collected = makeStore(clock);
    collected.restoreFromCommittedState({ ...exported, updates: [] });
    const planner = createBasePlanner({ store: collected, digest: sha256Digest });

    const plan = await planner.plan(baseRequest({ requestedFromSeq: 2 }));
    expect(plan?.upToSeq).toBe(2);
    expect(plan?.mode).toBe("full");
    expect(Y.equalSnapshots(Y.snapshot(applyToFreshDoc(plan?.payload)), Y.snapshot(serverDoc))).toBe(true);

    // 已知边界：未指认起点时锚点退回规范基线，读取出口无法区分「无新内容」与「缺口」，只能给到基线快照。
    const fallback = await planner.plan(baseRequest());
    expect(fallback?.upToSeq).toBe(0);
    expect(applyToFreshDoc(fallback?.payload).getText("t").toString()).toBe("base");
  });

  // 非整数起点是调用方错误：立即失败，不把它退化成规范基线。
  test("requestedFromSeq 非整数时抛协议错误", async () => {
    const { store } = await seedSession([{ kind: "append", text: " one" }]);
    const planner = createBasePlanner({ store, digest: sha256Digest });

    await expect(planner.plan(baseRequest({ requestedFromSeq: 1.5 }))).rejects.toMatchObject({
      code: "MALFORMED_FRAME",
    });
  });
});

describe("TailPlanner", () => {
  // 连续记录合并成一个批次，游标从 afterSeq+1 起推进，重放合并载荷与逐条重放等价。
  test("连续已提交更新合并成批且重放等价", async () => {
    const { store, serverDoc, snapshot } = await seedSession([
      { kind: "append", text: " one" },
      { kind: "append", text: " two" },
      { kind: "append", text: " three" },
    ]);
    const planner = createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: 4_096 });

    const batches = await planner.next(DOC_ID, 0, 10);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.docId).toBe(DOC_ID);
    expect([batches[0]?.fromSeq, batches[0]?.toSeq]).toEqual([1, 3]);
    expect(await planner.next(DOC_ID, 3, 10)).toEqual([]);

    const replay = applyToFreshDoc(snapshot);
    Y.applyUpdate(replay, batches[0]?.payload ?? new Uint8Array());
    expect(Y.equalSnapshots(Y.snapshot(replay), Y.snapshot(serverDoc))).toBe(true);
  });

  // 字节上限决定每批记录数：上限收紧后必须拆成多批，且每批载荷都不超过上限。
  test("批次字节上限被遵守且批次之间连续", async () => {
    const text = "x".repeat(100);
    const { store, serverDoc, snapshot, updates } = await seedSession([
      { kind: "append", text },
      { kind: "append", text },
      { kind: "append", text },
      { kind: "append", text },
    ]);
    const widest = Math.max(...updates.map((update) => update.byteLength));
    const maxBatchBytes = widest + 40;
    const planner = createTailPlanner({ store, digest: sha256Digest, maxBatchBytes });

    const batches = await planner.next(DOC_ID, 0, 20);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.payload.byteLength).toBeLessThanOrEqual(maxBatchBytes);
    expect(batches[0]?.fromSeq).toBe(1);
    for (let index = 1; index < batches.length; index += 1) {
      expect(batches[index]?.fromSeq).toBe((batches[index - 1]?.toSeq ?? 0) + 1);
    }
    expect(batches.at(-1)?.toSeq).toBe(updates.length);

    const replay = applyToFreshDoc(snapshot);
    for (const batch of batches) Y.applyUpdate(replay, batch.payload);
    expect(Y.equalSnapshots(Y.snapshot(replay), Y.snapshot(serverDoc))).toBe(true);
  });

  // 单条已提交更新不可切分：它超过上限时独占一批，否则该 Doc 永远追不上前沿。
  test("单条记录超过上限时独占一批", async () => {
    const text = "x".repeat(100);
    const { store } = await seedSession([
      { kind: "append", text },
      { kind: "append", text },
      { kind: "append", text },
    ]);
    const planner = createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: 8 });

    const batches = await planner.next(DOC_ID, 0, 20);
    expect(batches.map((batch) => [batch.fromSeq, batch.toSeq])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  // 批次数量受 limit 限制，续读从新的游标开始，不重发已发送的记录。
  test("批次数量受 limit 限制且续读不重发", async () => {
    const { store } = await seedSession([
      { kind: "append", text: " one" },
      { kind: "append", text: " two" },
      { kind: "append", text: " three" },
    ]);
    const planner = createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: 24 });

    const first = await planner.next(DOC_ID, 0, 2);
    expect(first).toHaveLength(2);
    expect(first.map((batch) => batch.fromSeq)).toEqual([1, 2]);
    const rest = await planner.next(DOC_ID, first.at(-1)?.toSeq ?? 0, 10);
    expect(rest.map((batch) => batch.fromSeq)).toEqual([3]);
    expect(await planner.next(DOC_ID, 0, 0)).toEqual([]);
  });

  // 缺口之后的更新一律不返回（不跳洞）：尾部缺失时宁可停下，由调用方换新 base 补齐。
  test("缺口之后的更新不被返回", async () => {
    const { store, clock } = await seedSession([
      { kind: "append", text: " one" },
      { kind: "append", text: " two" },
      { kind: "append", text: " three" },
    ]);
    const exported = store.exportCommittedState();
    const gapped = makeStore(clock);
    gapped.restoreFromCommittedState({
      ...exported,
      updates: exported.updates.filter((update) => update.updateSeq !== 2),
    });
    const planner = createTailPlanner({ store: gapped, digest: sha256Digest, maxBatchBytes: 4_096 });

    expect((await planner.next(DOC_ID, 0, 10)).map((batch) => [batch.fromSeq, batch.toSeq])).toEqual([[1, 1]]);
    expect(await planner.next(DOC_ID, 1, 10)).toEqual([]);
    expect(await planner.next("missing-doc", 0, 10)).toEqual([]);
  });

  // 页内缺口同样不得被跳过：读侧越过缺口时批次必须停在缺口前，不得把缺口之后的记录当连续载荷发出去。
  test("页内缺口之后的记录不被返回", async () => {
    const { store } = await seedSession([
      { kind: "append", text: " one" },
      { kind: "append", text: " two" },
      { kind: "append", text: " three" },
      { kind: "append", text: " four" },
      { kind: "append", text: " five" },
    ]);
    const violating = gapCrossingStore(store, [3, 4]);
    const planner = createTailPlanner({ store: violating, digest: sha256Digest, maxBatchBytes: 4_096 });

    // 同一页里 1、2 之后直接是 5：批次只能覆盖到 2，5 不得被当作连续载荷下发
    expect((await planner.next(DOC_ID, 0, 10)).map((batch) => [batch.fromSeq, batch.toSeq])).toEqual([[1, 2]]);
    // 从缺口处续读同样返回空：调用方据此换新 base，而不是停在一个永远不会到达的序号上
    expect(await planner.next(DOC_ID, 2, 10)).toEqual([]);
  });

  // 摘要只覆盖返回的载荷字节，供接收端做传输校验。
  test("批次摘要只覆盖返回的载荷字节", async () => {
    const { store } = await seedSession([{ kind: "append", text: " one" }]);
    const seen: Uint8Array[] = [];
    const digest: DigestFn = (bytes) => {
      seen.push(bytes);
      return `len:${bytes.byteLength}`;
    };
    const planner = createTailPlanner({ store, digest, maxBatchBytes: 4_096 });

    const batches = await planner.next(DOC_ID, 0, 10);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(batches[0]?.payload);
    expect(batches[0]?.digest).toBe(`len:${batches[0]?.payload.byteLength ?? -1}`);
  });

  // tail 规划只经只读出口取值，不得绕开原语直接读内存状态。
  test("tail 规划只使用 readUpdatesAfter", async () => {
    const { store } = await seedSession([{ kind: "append", text: " one" }]);
    const { store: recording, calls } = recordingStore(store);
    const planner = createTailPlanner({ store: recording, digest: sha256Digest, maxBatchBytes: 4_096 });

    await planner.next(DOC_ID, 0, 10);
    expect(new Set(calls)).toEqual(new Set(["readUpdatesAfter"]));
  });

  // 缺口判定：只有序号正好等于期望值时才算连续，跳号/重复/异代/非法序号一律要求补齐。
  test("detectGap 覆盖跳号、重复、异代与非法序号", async () => {
    const { store } = await seedSession();
    const planner = createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: 4_096 });

    expect(planner.detectGap(DOC_ID, 5, 5)).toBe(false);
    expect(planner.detectGap(DOC_ID, 5, 6)).toBe(true); // 跳号
    expect(planner.detectGap(DOC_ID, 5, 4)).toBe(true); // 重复/过期
    expect(planner.detectGap(DOC_ID, 42, 1)).toBe(true); // 异代次从 1 重新计数
    expect(planner.detectGap(DOC_ID, Number.NaN, 1)).toBe(true);
    expect(planner.detectGap(DOC_ID, 1, -1)).toBe(true);
  });

  // 非法预算与游标是接线错误：立即失败，避免静默空批次让 Doc 永久停更。
  test("非法预算与游标立即失败", async () => {
    const { store } = await seedSession();
    expect(() => createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: 0 })).toThrow();
    const planner = createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: 4_096 });
    await expect(planner.next(DOC_ID, -1, 10)).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    await expect(planner.next(DOC_ID, 0, Number.NaN)).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
  });
});
