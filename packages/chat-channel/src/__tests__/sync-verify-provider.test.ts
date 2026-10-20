// packages/chat-channel/src/__tests__/sync-verify-provider.test.ts
// 对抗验证复现集（E 阶段 provider / F 阶段客户端）：
//   - 失败用例 = 已确认缺陷的最小复现（断言指向实现行为，不是测试写法）；
//   - 通过用例 = 本次实测为正确的关键边界，作为证据固化。
// 不修改 packages/chat-channel/src/sync/** 任何源码。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type ApplyOutcome, type ApplyTask, createDocHub, type DocHubOptions } from "../sync/client/doc-hub";
import { type Clock, sha256Digest } from "../sync/clock";
import { buildDocId } from "../sync/protocol/identity";
import { createAckLedger } from "../sync/provider/ack-ledger";
import { createBasePlanner } from "../sync/provider/base-plan";
import { createQuotaController, type QuotaController } from "../sync/provider/quota";
import { createTailPlanner } from "../sync/provider/tail-plan";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { SyncDocRecord, SyncGenerationRecord, WriterLease } from "../sync/store/types";

const SCOPE = "org-verify/session-verify";
const GENERATION = "gen_verify00000000";
const DOC_ID = buildDocId({ kind: "runtime", generation: GENERATION, blockIndex: 0, nonce: "nonce-v" });
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;

/** 生产连接窗口与 socket 水位（capacity/concurrency 的冻结值，规格 §3.2「512KiB 为单连接最高值」）。 */
const CONNECTION_WINDOW_BYTES = 524_288;
/** 公平权重（实时 8 / 当前历史 3 / 后台历史 1 来自 FAIRNESS_CONFIG；控制类权重由会话层给定，这里取 1）。 */
const FAIRNESS = { control: 1, realtime: 8, "history-current": 3, "history-background": 1 } as const;
/** 典型实时帧字节数：288KiB 上限下的小帧。 */
const REALTIME_FRAME_BYTES = 4_096;

class TestClock implements Clock {
  now(): number {
    return 1_000;
  }
}

type TaskClass = Parameters<QuotaController["tryReserve"]>[0];

function makeQuota(options: Partial<Parameters<typeof createQuotaController>[0]> = {}): QuotaController {
  return createQuotaController({
    maxOutstandingBytes: CONNECTION_WINDOW_BYTES,
    socketHighWatermark: CONNECTION_WINDOW_BYTES,
    fairness: FAIRNESS,
    maxDirtyDocs: 128,
    ...options,
  });
}

/** 连续申请同类帧直到被拒，返回获批帧数（不归还，模拟「未 ACK 占满额度」）。 */
function reserveUntilRefused(quota: QuotaController, taskClass: TaskClass, bytes: number): number {
  let granted = 0;
  while (quota.tryReserve(taskClass, bytes, 0)) {
    granted += 1;
  }
  return granted;
}

function releaseTimes(quota: QuotaController, taskClass: TaskClass, bytes: number, times: number): void {
  for (let index = 0; index < times; index += 1) {
    quota.release(taskClass, bytes);
  }
}

// ─────────────────────────── E 阶段 quota ───────────────────────────

describe("quota 四类公平轮转", () => {
  // 复现缺陷：轮次结束条件把「获授予过但此后静默」的类永远视为未用尽，导致轮次无法推进，
  // 持续发送的实时类在窗口完全空闲时也退化为单帧在途（对照：控制类从未获授予时可用满整窗）。
  test("实时负载的在途上限不得取决于控制类是否曾经发过一帧", () => {
    // 对照：控制类从未获授予 —— 实时类用满份额后再归还，仍可继续填满整窗。
    const controlFree = makeQuota();
    const controlFreeBurst = reserveUntilRefused(controlFree, "realtime", REALTIME_FRAME_BYTES);
    releaseTimes(controlFree, "realtime", REALTIME_FRAME_BYTES, controlFreeBurst);
    const controlFreeAfterAck = reserveUntilRefused(controlFree, "realtime", REALTIME_FRAME_BYTES);

    // 被测：握手期发过一帧控制流（100 字节），此后控制类静默，其余全部 ACK。
    const withSilentControl = makeQuota();
    expect(withSilentControl.tryReserve("control", 100, 0)).toBe(true);
    const silentControlBurst = reserveUntilRefused(withSilentControl, "realtime", REALTIME_FRAME_BYTES);
    releaseTimes(withSilentControl, "realtime", REALTIME_FRAME_BYTES, silentControlBurst);
    withSilentControl.release("control", 100);
    expect(withSilentControl.snapshot().outstandingBytes).toBe(0);
    const silentControlAfterAck = reserveUntilRefused(withSilentControl, "realtime", REALTIME_FRAME_BYTES);

    // 裁决（2026-10-16）：设计 §10.5 规定「控制流使用受限独立份额」——控制类不参与发送正文的
    // deficit round robin，其 100 字节在途只占连接窗口、不阻塞正文类的轮次推进。实时类的在途上限
    // 因此由「窗口 − 已在途字节」决定，而不是被压到自己的单轮份额（512KiB × 8/13 ≈ 78 帧）。
    const windowLimitedBurst = Math.floor((CONNECTION_WINDOW_BYTES - 100) / REALTIME_FRAME_BYTES);
    expect(silentControlBurst).toBe(windowLimitedBurst);
    // 静默类一旦结清，必须与「控制类从未获授予」的对照逐值相等。
    expect(silentControlAfterAck).toBe(controlFreeAfterAck);
  });

  // 512KiB 是单连接最高值而非预分配：初始 outstanding 为 0，bufferedAmount + 帧字节恰好触水位时放行。
  test("额度是动态授予的上限而非预分配，socket 水位取等号放行", () => {
    const quota = makeQuota();
    expect(quota.snapshot()).toEqual({ outstandingBytes: 0, grantedBytes: 0, pendingTasks: 0 });
    const frame = 2_048;
    expect(quota.tryReserve("realtime", frame, CONNECTION_WINDOW_BYTES - frame)).toBe(true);
    expect(quota.snapshot().outstandingBytes).toBe(frame);
  });

  // dirty 集合上限 128：恰好 128 个合法，第 129 个抛 CAPACITY_EXCEEDED 要求关闭连接重新握手。
  test("dirty 集合在 128 个之内合法，第 129 个要求重连", () => {
    const quota = makeQuota();
    for (let index = 0; index < 128; index += 1) {
      quota.markDirty(`sync/runtime/${GENERATION}/0/n${index}`);
    }
    expect(quota.dirtyCount()).toBe(128);
    expect(() => quota.markDirty(`sync/runtime/${GENERATION}/0/n128`)).toThrow();
    quota.clearDirty(`sync/runtime/${GENERATION}/0/n0`);
    quota.markDirty(`sync/runtime/${GENERATION}/0/n128`);
    expect(quota.dirtyCount()).toBe(128);
  });
});

// ─────────────────────────── E 阶段 ack-ledger ───────────────────────────

describe("ack-ledger 退额度的账目", () => {
  // 重复 / 未来 / 旧代次 / 断连清账后的 ACK 一律不加额度：逐项用数值断言余额不变。
  test("无效 ACK 不改变额度余额，且只按服务端记录值归还", () => {
    const quota = makeQuota();
    const released: Array<{ taskClass: TaskClass; bytes: number }> = [];
    const ledger = createAckLedger({
      onRelease: (taskClass, bytes) => {
        released.push({ taskClass, bytes });
        quota.release(taskClass, bytes);
      },
    });
    const current = "tx_verify0001";
    const previous = "tx_verify0000";

    expect(quota.tryReserve("history-background", 4_096, 0)).toBe(true);
    ledger.record({
      transportEpoch: current,
      deliveryId: "dlv_recorded",
      docId: DOC_ID,
      fromSeq: 1,
      toSeq: 1,
      bytes: 4_096,
      taskClass: "history-background",
    });
    // 重复记账同一 deliveryId：只记一次
    ledger.record({
      transportEpoch: current,
      deliveryId: "dlv_recorded",
      docId: DOC_ID,
      fromSeq: 1,
      toSeq: 1,
      bytes: 4_096,
      taskClass: "history-background",
    });
    expect(ledger.outstandingCount()).toBe(1);

    const before = quota.snapshot();
    // 未来 deliveryId、旧代次、重复 ACK：三种都不动余额
    expect(ledger.settle({ transportEpoch: current, deliveryId: "dlv_future", result: "processed" })).toBe(0);
    expect(ledger.settle({ transportEpoch: previous, deliveryId: "dlv_recorded", result: "processed" })).toBe(0);
    expect(quota.snapshot()).toEqual(before);
    expect(ledger.outstandingCount()).toBe(1);

    // 同代次第一次 ACK：按服务端记录值归还
    expect(ledger.settle({ transportEpoch: current, deliveryId: "dlv_recorded", result: "processed" })).toBe(4_096);
    expect(quota.snapshot().outstandingBytes).toBe(0);
    // 重复 ACK：不再归还
    expect(ledger.settle({ transportEpoch: current, deliveryId: "dlv_recorded", result: "processed" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(0);
    expect(released).toEqual([{ taskClass: "history-background", bytes: 4_096 }]);

    // 断连清账后旧 ACK 不能归还
    expect(quota.tryReserve("control", 512, 0)).toBe(true);
    ledger.record({
      transportEpoch: current,
      deliveryId: "dlv_gone",
      docId: DOC_ID,
      fromSeq: 2,
      toSeq: 2,
      bytes: 512,
      taskClass: "control",
    });
    ledger.reset();
    quota.reset();
    expect(ledger.settle({ transportEpoch: current, deliveryId: "dlv_gone", result: "processed" })).toBe(0);
    expect(quota.snapshot().outstandingBytes).toBe(0);
  });
});

// ─────────────────────────── E 阶段 base-plan / tail-plan ───────────────────────────

interface SeededSession {
  readonly store: MemoryProjectionStore;
  readonly clock: TestClock;
  readonly lease: WriterLease;
  readonly serverDoc: Y.Doc;
  readonly baseSnapshot: Uint8Array;
  readonly updates: Uint8Array[];
}

/** 造出「基线快照 + 连续已提交更新」，每条更新的字节与 store 中追加的字节完全一致。 */
async function seedSession(edits: readonly string[]): Promise<SeededSession> {
  const clock = new TestClock();
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
  const lease = await store.acquireWriter(SCOPE, "writer-verify", 60_000);
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE,
    generation: GENERATION,
    acpSessionId: "acp-verify",
    loadId: "load-verify",
    state: "staging",
    importEndOrdinal: null,
    entryRefs: {
      controlDocId: buildDocId({ kind: "control", generation: GENERATION, blockIndex: 0, nonce: "c" }),
      directoryDocId: buildDocId({ kind: "directory", generation: GENERATION, blockIndex: 0, nonce: "d" }),
      runtimeDocId: DOC_ID,
      contentDocIds: [],
    },
    createdAt: 1_000,
  };
  await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation });

  const serverDoc = new Y.Doc();
  serverDoc.getText("t").insert(0, "base");
  const baseSnapshot = Y.encodeStateAsUpdate(serverDoc);
  const record: SyncDocRecord = {
    scopeKey: SCOPE,
    generation: GENERATION,
    docId: DOC_ID,
    kind: "runtime",
    state: "active",
    snapshot: baseSnapshot,
    hash: sha256Digest(baseSnapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: null,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
  await store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: record });

  const updates: Uint8Array[] = [];
  let frontier = 0;
  let stateVector = Y.encodeStateVector(serverDoc);
  for (const text of edits) {
    serverDoc.getText("t").insert(serverDoc.getText("t").length, text);
    const bytes = Y.encodeStateAsUpdate(serverDoc, stateVector);
    stateVector = Y.encodeStateVector(serverDoc);
    updates.push(bytes);
    frontier += 1;
    await store.appendUpdates({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      owner: lease.owner,
      batchId: `batch-${frontier}`,
      digest: `digest-${frontier}`,
      expectedFrontiers: [{ docId: DOC_ID, lastSeq: frontier - 1 }],
      updates: [{ docId: DOC_ID, fromSeq: frontier, bytes }],
    });
  }
  return { store, clock, lease, serverDoc, baseSnapshot, updates };
}

function applyAll(payloads: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const payload of payloads) {
    Y.applyUpdate(doc, payload);
  }
  return doc;
}

describe("base-plan / tail-plan", () => {
  // 差分必须携带 delete-set：把它应用回客户端基线后，内容与服务端状态逐项等价，且状态向量与 plan 一致。
  test("差分含删除且应用后等价，状态向量与返回载荷一致", async () => {
    const { store, serverDoc, baseSnapshot, updates } = await seedSession([" one", " two"]);
    // 服务端再删除 "base" 前缀并在开头插入 "X"（状态向量必须在改动前取，否则增量里只有 delete-set）
    const beforeEdit = Y.encodeStateVector(serverDoc);
    serverDoc.getText("t").delete(0, 4);
    serverDoc.getText("t").insert(0, "X");
    await store.appendUpdates({
      scopeKey: SCOPE,
      epoch: 1,
      owner: "writer-verify",
      batchId: "batch-3",
      digest: "digest-3",
      expectedFrontiers: [{ docId: DOC_ID, lastSeq: 2 }],
      updates: [{ docId: DOC_ID, fromSeq: 3, bytes: Y.encodeStateAsUpdate(serverDoc, beforeEdit) }],
    });
    const planner = createBasePlanner({ store, digest: sha256Digest });
    // 客户端基线 = 基线快照 + 第 1 条更新（可信基线）
    const client = applyAll([baseSnapshot, updates[0] ?? new Uint8Array()]);
    const plan = await planner.plan({
      docId: DOC_ID,
      generation: GENERATION,
      subscriptionEpoch: "sub_v",
      syncAttemptId: "att_v",
      clientStateVector: Y.encodeStateVector(client),
    });

    expect(plan?.mode).toBe("diff");
    expect(plan?.upToSeq).toBe(3);
    const applied = new Y.Doc();
    Y.applyUpdate(applied, Y.encodeStateAsUpdate(client));
    Y.applyUpdate(applied, plan?.payload ?? new Uint8Array());
    expect(applied.getText("t").toString()).toBe(serverDoc.getText("t").toString());
    expect(Y.equalSnapshots(Y.snapshot(applied), Y.snapshot(serverDoc))).toBe(true);
    // 载荷的状态向量必须与 plan 报告的 stateVector 一致（否则调用方无法据此推进本地基线）
    expect(Array.from(Y.encodeStateVector(applied))).toEqual(Array.from(plan?.stateVector ?? new Uint8Array()));
  });

  // 序号缺口不被跳过：base 必须停在缺口前的连续前沿，tail 在缺口处返回空而不是缺口之后的记录。
  test("缺口之后的更新既不被 base 也不被 tail 返回", async () => {
    const { store, clock, baseSnapshot, updates } = await seedSession(["1", "2", "3", "4"]);
    const exported = store.exportCommittedState();
    const gapped = new MemoryProjectionStore({
      clock,
      digest: sha256Digest,
      capacity: DEFAULT_SYNC_CAPACITY,
      lifecycle: LIFECYCLE,
    });
    gapped.restoreFromCommittedState({
      ...exported,
      updates: exported.updates.filter((update) => update.updateSeq !== 3),
    });

    const basePlanner = createBasePlanner({ store: gapped, digest: sha256Digest });
    const plan = await basePlanner.plan({
      docId: DOC_ID,
      generation: GENERATION,
      subscriptionEpoch: "sub_v",
      syncAttemptId: "att_v",
    });
    expect(plan?.mode).toBe("full");
    expect(plan?.upToSeq).toBe(2);
    const expected = applyAll([baseSnapshot, updates[0] ?? new Uint8Array(), updates[1] ?? new Uint8Array()]);
    const applied = applyAll([plan?.payload ?? new Uint8Array()]);
    expect(applied.getText("t").toString()).toBe(expected.getText("t").toString());

    const tailPlanner = createTailPlanner({ store: gapped, digest: sha256Digest, maxBatchBytes: 4_096 });
    expect((await tailPlanner.next(DOC_ID, 0, 10)).map((batch) => [batch.fromSeq, batch.toSeq])).toEqual([[1, 2]]);
    expect(await tailPlanner.next(DOC_ID, 2, 10)).toEqual([]);
  });

  // 尾部批次跨页（每页 64 条记录）仍必须连续且不重发：limit 大于一页时序号 1..N 逐一出现。
  test("跨页批次连续且不重发", async () => {
    const { store } = await seedSession(Array.from({ length: 200 }, (_, index) => `u${index}`));
    const planner = createTailPlanner({ store, digest: sha256Digest, maxBatchBytes: 1 });
    const first = await planner.next(DOC_ID, 0, 70);
    expect(first.length).toBe(70);
    expect(first.every((batch, index) => batch.fromSeq === index + 1 && batch.toSeq === index + 1)).toBe(true);
    const rest = await planner.next(DOC_ID, first.at(-1)?.toSeq ?? 0, 5);
    expect(rest.map((batch) => batch.fromSeq)).toEqual([71, 72, 73, 74, 75]);
    expect(first.every((batch) => batch.payload.byteLength > 0)).toBe(true);
    expect(Y.mergeUpdates(first.map((batch) => batch.payload)).byteLength).toBeGreaterThan(0);
  });
});

// ─────────────────────────── F 阶段 doc-hub ───────────────────────────

const SUB_EPOCH = "sub_verify0001";
const ATTEMPT = "att_verify0001";

function encodedDoc(text: string): Uint8Array {
  const doc = new Y.Doc();
  if (text.length > 0) {
    doc.getText("body").insert(0, text);
  }
  const payload = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return payload;
}

function verifyTask(overrides: Partial<ApplyTask> = {}): ApplyTask {
  return {
    kind: "base",
    docId: DOC_ID,
    generation: GENERATION,
    subscriptionEpoch: SUB_EPOCH,
    syncAttemptId: ATTEMPT,
    deliveryId: "dlv_v0",
    fromSeq: 0,
    toSeq: 0,
    payload: encodedDoc(""),
    digest: "sha256:verify",
    ...overrides,
  };
}

function createHarness(overrides: Partial<DocHubOptions> = {}) {
  const outcomes: ApplyOutcome[] = [];
  const resyncs: string[] = [];
  const hub = createDocHub({
    maxQueueBytes: 1_048_576,
    maxQueueTasks: 64,
    budget: { maxBytes: 1_048_576, maxTasks: 64, maxMillis: 1_000 },
    now: () => 0,
    yieldToHost: async () => {},
    onOutcome: (outcome) => outcomes.push(outcome),
    onResyncRequired: (docId, reason) => resyncs.push(`${docId}:${reason}`),
    ...overrides,
  });
  hub.retain(DOC_ID);
  return { hub, outcomes, resyncs };
}

describe("doc-hub 状态机", () => {
  // 复现缺陷：同一 attempt 内到达的旧 base（服务端重传/乱序）会把已应用边界从 2 回退到 1，
  // 于是紧随其后的合法增量（fromSeq=3，服务端按 toSeq=2 推导）被判为序号缺口并触发多余的完整补齐。
  test("旧 base 重传不得回退已应用边界", async () => {
    const { hub, outcomes, resyncs } = createHarness();
    // 首个 base 把边界推到 seq 2
    hub.enqueue(verifyTask({ deliveryId: "dlv_base_new", toSeq: 2, payload: encodedDoc("base") }));
    await hub.drain();
    // 同一 attempt 的旧 base（toSeq=1）后到
    hub.enqueue(verifyTask({ deliveryId: "dlv_base_old", toSeq: 1, payload: encodedDoc("stale") }));
    await hub.drain();
    // 内容仍然连续：seq 3 的增量必须被应用
    hub.enqueue(
      verifyTask({
        kind: "update",
        deliveryId: "dlv_u3",
        fromSeq: 3,
        toSeq: 3,
        payload: encodedDoc("u3"),
      }),
    );
    await hub.drain();

    expect(outcomes.map((outcome) => `${outcome.result}:${outcome.reason ?? ""}`)).toEqual([
      "processed:",
      "processed:",
      "processed:",
    ]);
    expect(resyncs).toEqual([]);
    hub.dispose();
  });

  // apply 抛异常（空载荷 / 截断载荷不可被 Yjs 解析）时只发 rejected，不得发 processed，也不得继续用该实例。
  test("不可解析的载荷只发 rejected 并申请补齐", async () => {
    const { hub, outcomes, resyncs } = createHarness();
    hub.enqueue(
      verifyTask({
        deliveryId: "dlv_broken",
        toSeq: 5,
        payload: new Uint8Array(0),
      }),
    );
    await hub.drain();
    expect(outcomes.map((outcome) => outcome.result)).toEqual(["rejected"]);
    expect(resyncs).toHaveLength(1);
    expect(hub.loadedBytes()).toBe(0);
    hub.dispose();
  });

  // ACK 时序：onOutcome 触发时该帧字节已计入驻留、任务已出队（接收额度已归还）。
  test("回调时本帧已出队且已计入驻留字节", async () => {
    const observed: Array<{ queueDepth: number; loadedBytes: number }> = [];
    const payload = encodedDoc("payload");
    const hub = createDocHub({
      maxQueueBytes: 1_048_576,
      maxQueueTasks: 64,
      budget: { maxBytes: 1_048_576, maxTasks: 64, maxMillis: 1_000 },
      now: () => 0,
      yieldToHost: async () => {},
      onOutcome: () => observed.push({ queueDepth: hub.queueDepth(), loadedBytes: hub.loadedBytes() }),
      onResyncRequired: () => {},
    });
    hub.retain(DOC_ID);
    hub.enqueue(verifyTask({ payload, toSeq: 0 }));
    await hub.drain();
    expect(observed).toEqual([{ queueDepth: 0, loadedBytes: payload.byteLength }]);
    hub.dispose();
  });

  // 接收队列的字节上界取等号放行、越 1 字节拒绝；上限内的任务不被驱逐。
  test("接收队列字节上界取等号放行", async () => {
    const payload = encodedDoc("x");
    const { hub, outcomes } = createHarness({ maxQueueBytes: payload.byteLength, maxQueueTasks: 64 });
    hub.enqueue(verifyTask({ deliveryId: "dlv_fit", payload }));
    await hub.drain();
    expect(outcomes.map((outcome) => outcome.result)).toEqual(["processed"]);
    // 第二帧必须复用同一份编码字节：new Y.Doc() 的 client ID 随机，重新编码偶尔多 1 字节，
    // 会越过单项上限触发 payload-too-large，测不到队列溢出。
    const second = createHarness({ maxQueueBytes: payload.byteLength, maxQueueTasks: 64 });
    second.hub.enqueue(verifyTask({ deliveryId: "dlv_a", payload }));
    second.hub.enqueue(verifyTask({ deliveryId: "dlv_b", payload }));
    expect(second.outcomes.map((outcome) => outcome.reason)).toEqual(["queue-overflow"]);
    hub.dispose();
    second.hub.dispose();
  });
});

// ─────────────────────────── F 阶段浏览器安全 ───────────────────────────

/** 递归收集客户端入口的值导入闭包：`import type` 会被擦除，不进入浏览器 bundle，故跳过。 */
function valueImportClosure(entry: string): { files: string[]; offenders: string[] } {
  const files: string[] = [];
  const offenders: string[] = [];
  const seen = new Set<string>();
  const resolveSpecifier = (from: string, specifier: string): string | null => {
    const target = resolve(dirname(from), specifier);
    const candidates = [`${target}.ts`, resolve(target, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  };
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*import\s+(type\s+)?[^"';]*from\s+["']([^"']+)["']/gm)) {
      const onlyType = match[1] !== undefined;
      const specifier = match[2] ?? "";
      if (onlyType) continue;
      if (specifier.startsWith(".")) {
        const next = resolveSpecifier(file, specifier);
        if (next !== null) walk(next);
        continue;
      }
      if (specifier.startsWith("node:") || ["fs", "path", "crypto", "buffer", "process"].includes(specifier)) {
        offenders.push(`${file} → ${specifier}`);
      }
    }
  };
  walk(entry);
  return { files, offenders };
}

describe("客户端浏览器安全", () => {
  // client/ 的值导入闭包不得触碰 node 内建、fs、process、Buffer：否则浏览器 bundle 加载即失败。
  test("client 目录的依赖闭包不含 node 运行时依赖", () => {
    const syncRoot = resolve(import.meta.dir, "../sync");
    const docHub = valueImportClosure(resolve(syncRoot, "client/doc-hub.ts"));
    const applyQueue = valueImportClosure(resolve(syncRoot, "client/apply-queue.ts"));
    expect(docHub.offenders).toEqual([]);
    expect(applyQueue.offenders).toEqual([]);
    const closure = docHub.files.map((file) => file.replace(`${syncRoot}/`, ""));
    expect(closure.sort()).toEqual(
      ["client/doc-hub.ts", "client/apply-queue.ts", "protocol/errors.ts", "protocol/identity.ts"].sort(),
    );
  });
});
