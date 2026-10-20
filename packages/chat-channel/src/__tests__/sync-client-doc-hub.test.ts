// packages/chat-channel/src/__tests__/sync-client-doc-hub.test.ts
// F 阶段客户端 apply 队列与 DocHub（设计 §8.6，规格 §3.3）的行为回归：入队边界、队列上界、
// apply 与确认的次序、失败后的补齐申请、引用计数与释放。时间取注入的 now，无真实等待。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createApplyQueue } from "../sync/client/apply-queue";
import {
  APPLY_REJECT_REASONS,
  type ApplyOutcome,
  type ApplyTask,
  createDocHub,
  type DocHub,
  type DocHubOptions,
} from "../sync/client/doc-hub";
import { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId } from "../sync/protocol/identity";

const GENERATION = "gen_clienttest0000";
const DOC_A = buildDocId({ kind: "content", generation: GENERATION, blockIndex: 1, nonce: "nonce-a" });
const DOC_B = buildDocId({ kind: "content", generation: GENERATION, blockIndex: 2, nonce: "nonce-b" });
const SUB_EPOCH = "sub_01234567";
const ATTEMPT = "att_01234567";
const SECOND_ATTEMPT = "att_89abcdef";

let deliveryCounter = 0;

function nextDeliveryId(): string {
  deliveryCounter += 1;
  return `dlv_${String(deliveryCounter).padStart(8, "0")}`;
}

/**
 * 真实 Yjs 编码的载荷：同一载荷可反复应用（Yjs 合并幂等），字节长度可作为计费输入；
 * 每次编码的 clientID 长度不同，逐条重编码会让字节断言不可复现。
 */
function encodedPayload(text = ""): Uint8Array {
  const doc = new Y.Doc();
  if (text.length > 0) {
    doc.getText("body").insert(0, text);
  }
  const payload = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return payload;
}

function baseTask(docId: string, overrides: Partial<ApplyTask> = {}): ApplyTask {
  return {
    kind: "base",
    docId,
    generation: GENERATION,
    subscriptionEpoch: SUB_EPOCH,
    syncAttemptId: ATTEMPT,
    deliveryId: nextDeliveryId(),
    fromSeq: 0,
    toSeq: 0,
    payload: encodedPayload(),
    digest: "sha256:test",
    ...overrides,
  };
}

function updateTask(docId: string, seq: number, overrides: Partial<ApplyTask> = {}): ApplyTask {
  return baseTask(docId, {
    kind: "update",
    fromSeq: seq,
    toSeq: seq,
    payload: encodedPayload(`u${seq}`),
    ...overrides,
  });
}

/** 默认配置：预算足够大以隔离被测行为；需要字节/时间预算的用例显式覆盖。 */
function hubOptions(overrides: Partial<DocHubOptions> = {}): DocHubOptions {
  return {
    maxQueueBytes: 4096,
    maxQueueTasks: 8,
    budget: { maxBytes: 4096, maxTasks: 8, maxMillis: 1000 },
    now: () => 0,
    yieldToHost: async () => {},
    onOutcome: () => {},
    onResyncRequired: () => {},
    ...overrides,
  };
}

/** 测试用装配：记录结果与补齐申请，并统计让出执行权的次数。 */
function createHarness(overrides: Partial<DocHubOptions> = {}) {
  const outcomes: ApplyOutcome[] = [];
  const resyncs: Array<{ docId: string; reason: string }> = [];
  let yields = 0;
  const hub = createDocHub(
    hubOptions({
      yieldToHost: async () => {
        yields += 1;
      },
      onOutcome: (outcome) => outcomes.push(outcome),
      onResyncRequired: (docId, reason) => resyncs.push({ docId, reason }),
      ...overrides,
    }),
  );
  return { hub, outcomes, resyncs, yieldCount: () => yields };
}

/** 建立可信基线（`toSeq` 之后的连续增量才可应用，§8.4），返回基线载荷字节数供断言使用。 */
async function prime(hub: DocHub, docId: string, toSeq = 0): Promise<number> {
  const payload = encodedPayload(`base-${docId}`);
  hub.enqueue(baseTask(docId, { toSeq, payload }));
  await hub.drain();
  return payload.byteLength;
}

function processedDeliveryIds(outcomes: readonly ApplyOutcome[]): string[] {
  return outcomes.filter((outcome) => outcome.result === "processed").map((outcome) => outcome.deliveryId);
}

describe("sync apply queue 有界接收队列", () => {
  // 条数上限挡「大量极小帧」、字节上限挡「少量超大帧」；溢出只拒绝新任务，不驱逐已入队任务。
  test("条数与字节双上限：溢出拒绝新任务且不驱逐已入队任务", () => {
    const byCount = createApplyQueue({ maxBytes: 1024, maxTasks: 2 });
    expect(byCount.push({ task: baseTask(DOC_A), bytes: 1 })).toBe(true);
    expect(byCount.push({ task: updateTask(DOC_A, 1), bytes: 1 })).toBe(true);
    expect(byCount.push({ task: updateTask(DOC_A, 2), bytes: 1 })).toBe(false);
    expect(byCount.size()).toBe(2);
    expect(byCount.pendingBytes()).toBe(2);
    const byBytes = createApplyQueue({ maxBytes: 10, maxTasks: 8 });
    expect(byBytes.push({ task: baseTask(DOC_A), bytes: 6 })).toBe(true);
    expect(byBytes.push({ task: updateTask(DOC_A, 1), bytes: 6 })).toBe(false);
    expect(byBytes.pendingBytes()).toBe(6);
    expect(byBytes.take()?.bytes).toBe(6);
    expect(byBytes.pendingBytes()).toBe(0);
    expect(byBytes.take()).toBeNull();
  });

  // base 是增量可应用的前提，取任务时必须优先，否则同 Doc 的增量会长期压制自己的基线。
  test("take 优先返回 base，同类任务按入队顺序", () => {
    const queue = createApplyQueue({ maxBytes: 1024, maxTasks: 8 });
    const first = baseTask(DOC_A, { deliveryId: "dlv_first" });
    const second = updateTask(DOC_A, 1, { deliveryId: "dlv_second" });
    const third = baseTask(DOC_B, { deliveryId: "dlv_third" });
    for (const task of [first, second, third]) {
      queue.push({ task, bytes: 1 });
    }
    expect(queue.take()?.task.deliveryId).toBe("dlv_first");
    expect(queue.take()?.task.deliveryId).toBe("dlv_third");
    expect(queue.take()?.task.deliveryId).toBe("dlv_second");
  });

  // 换 attempt 要按身份作废旧帧：丢弃项必须原样返回，账实一致才能让调用方补 rejected ACK。
  test("discardWhere 按谓词移除并按入队顺序返回被丢弃项", () => {
    const queue = createApplyQueue({ maxBytes: 1024, maxTasks: 8 });
    const stale = updateTask(DOC_A, 1, { syncAttemptId: "att_old" });
    queue.push({ task: stale, bytes: 3 });
    queue.push({ task: updateTask(DOC_A, 2, { syncAttemptId: ATTEMPT }), bytes: 4 });
    const discarded = queue.discardWhere((task) => task.syncAttemptId !== ATTEMPT);
    expect(discarded.map((entry) => entry.task.deliveryId)).toEqual([stale.deliveryId]);
    expect(queue.size()).toBe(1);
    expect(queue.pendingBytes()).toBe(4);
  });
});

describe("sync doc hub 入队边界校验", () => {
  // 客户端不得因任意 docId 建文档：未 retain 的投递必须被拒绝且不占用接收预算。
  test("未 retain 的 docId 直接 rejected 且不入队", () => {
    const harness = createHarness();
    harness.hub.enqueue(baseTask(DOC_B));
    expect(harness.outcomes).toEqual([{ deliveryId: expect.any(String), result: "rejected", reason: "unknown-doc" }]);
    expect(harness.hub.queueDepth()).toBe(0);
  });

  // 代次只由握手/GENERATION_REPLACE 引入；非法 docId 则是调用方的编程错误，必须显式抛出。
  test("代次与谱系不一致时 rejected，非法 docId 无法 retain", () => {
    const harness = createHarness();
    expect(() => harness.hub.retain("sync/content/only-three-segments")).toThrow(SyncProtocolError);
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(baseTask(DOC_A, { generation: "gen_other0000" }));
    expect(harness.outcomes[0]?.reason).toBe(APPLY_REJECT_REASONS.generationMismatch);
    expect(harness.hub.queueDepth()).toBe(0);
  });

  // 容量拒绝分两类：单项永远放不下（载荷超预算）与当前放不下（队列已满），都不占接收额度。
  test("载荷超预算与队列已满时 rejected 且不驱逐已排队任务", () => {
    const oversized = createHarness({ maxQueueBytes: 64 });
    oversized.hub.retain(DOC_A);
    oversized.hub.enqueue(baseTask(DOC_A, { payload: new Uint8Array(128) }));
    expect(oversized.outcomes[0]?.reason).toBe(APPLY_REJECT_REASONS.payloadTooLarge);
    expect(oversized.hub.queueDepth()).toBe(0);
    const full = createHarness({ maxQueueTasks: 2 });
    full.hub.retain(DOC_A);
    full.hub.retain(DOC_B);
    full.hub.enqueue(baseTask(DOC_A));
    full.hub.enqueue(baseTask(DOC_B));
    full.hub.enqueue(updateTask(DOC_A, 1));
    expect(full.outcomes[0]?.reason).toBe(APPLY_REJECT_REASONS.queueOverflow);
    expect(full.hub.queueDepth()).toBe(2);
  });

  // 结构与归属校验先于协议状态判断：非法区间或非字节载荷不得入队，也不触发补齐申请。
  test("区间倒置或载荷非字节时 rejected malformed-task", () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(baseTask(DOC_A, { fromSeq: 3, toSeq: 2 }));
    harness.hub.enqueue(baseTask(DOC_A, { payload: "not-bytes" as unknown as Uint8Array }));
    expect(harness.outcomes.map((outcome) => outcome.reason)).toEqual([
      APPLY_REJECT_REASONS.malformedTask,
      APPLY_REJECT_REASONS.malformedTask,
    ]);
    expect(harness.hub.queueDepth()).toBe(0);
    expect(harness.resyncs).toHaveLength(0);
  });

  // BASE_READY 之前不存在可应用的增量：拒绝并申请补齐，避免把尾部并入不可信前置状态。
  test("base 之前到达的 update 被拒绝并申请补齐", () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(updateTask(DOC_A, 1));
    expect(harness.outcomes[0]?.reason).toBe(APPLY_REJECT_REASONS.baseNotReady);
    expect(harness.resyncs).toEqual([{ docId: DOC_A, reason: APPLY_REJECT_REASONS.baseNotReady }]);
    expect(harness.hub.queueDepth()).toBe(0);
  });
});

describe("sync doc hub apply 与确认次序", () => {
  // 正常路径：base 应用成功才产生 processed，驻留字节按载荷计，队列归还接收额度。
  test("base 应用成功后回调 processed 并计入驻留字节", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    const payload = encodedPayload("hello");
    const delivered = baseTask(DOC_A, { toSeq: 1, payload });
    harness.hub.enqueue(delivered);
    expect(harness.outcomes).toHaveLength(0);
    await harness.hub.drain();
    expect(harness.outcomes).toEqual([{ deliveryId: delivered.deliveryId, result: "processed" }]);
    expect(harness.hub.loadedBytes()).toBe(payload.byteLength);
    expect(harness.hub.queueDepth()).toBe(0);
  });

  // §8.6 第 4 条：ACK 只能在 apply 返回、校验完成、接收额度归还之后；入队不得确认任何投递。
  test("onOutcome 在 apply 返回且接收额度归还之后才回调", async () => {
    const seen: string[] = [];
    const hub = createDocHub(hubOptions({ onOutcome: () => seen.push(`${hub.loadedBytes()}/${hub.queueDepth()}`) }));
    hub.retain(DOC_A);
    const payload = encodedPayload("ordered");
    hub.enqueue(baseTask(DOC_A, { toSeq: 1, payload }));
    expect(seen).toHaveLength(0);
    await hub.drain();
    expect(seen).toEqual([`${payload.byteLength}/0`]);
  });

  // 连续 tail 按序推进游标并累加驻留字节：这是「可信 base + 无缺口更新」的账面证据。
  test("连续 update 依次 processed 并累加驻留字节", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    const baseBytes = await prime(harness.hub, DOC_A);
    const primed = harness.outcomes.length;
    const updates = [1, 2, 3].map((seq) => updateTask(DOC_A, seq));
    for (const item of updates) {
      harness.hub.enqueue(item);
    }
    await harness.hub.drain();
    const updateBytes = updates.reduce((total, item) => total + item.payload.byteLength, 0);
    expect(processedDeliveryIds(harness.outcomes.slice(primed))).toEqual(updates.map((item) => item.deliveryId));
    expect(harness.hub.loadedBytes()).toBe(baseBytes + updateBytes);
  });

  // 缺口必须显式补齐：继续应用会让「连续覆盖」不再成立，故停在缺口并申请 resync。
  test("序号缺口被拒绝并申请补齐，后续增量不再应用", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A, 5);
    const primed = harness.outcomes.length;
    const before = harness.hub.loadedBytes();
    const gapped = updateTask(DOC_A, 8);
    harness.hub.enqueue(gapped);
    harness.hub.enqueue(updateTask(DOC_A, 6));
    await harness.hub.drain();
    expect(harness.outcomes[primed]?.reason).toBe(APPLY_REJECT_REASONS.sequenceGap);
    expect(harness.outcomes[primed]?.deliveryId).toBe(gapped.deliveryId);
    expect(harness.resyncs).toEqual([{ docId: DOC_A, reason: APPLY_REJECT_REASONS.sequenceGap }]);
    expect(harness.hub.loadedBytes()).toBe(before);
    expect(harness.outcomes[primed + 1]?.reason).toBe(APPLY_REJECT_REASONS.baseNotReady);
  });

  // 重传/重复帧（已应用边界之内）只结清传输额度：不重复推进游标，也不要求重订基线。
  test("已应用边界内的重传被拒绝且不推进游标", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A);
    harness.hub.enqueue(updateTask(DOC_A, 1));
    await harness.hub.drain();
    const afterFirst = harness.hub.loadedBytes();
    const duplicate = updateTask(DOC_A, 1);
    harness.hub.enqueue(duplicate);
    await harness.hub.drain();
    expect(harness.outcomes[2]?.reason).toBe(APPLY_REJECT_REASONS.duplicateRange);
    expect(harness.outcomes[2]?.deliveryId).toBe(duplicate.deliveryId);
    expect(harness.hub.loadedBytes()).toBe(afterFirst);
    expect(harness.resyncs).toHaveLength(0);
    harness.hub.enqueue(updateTask(DOC_A, 2));
    await harness.hub.drain();
    expect(harness.outcomes[3]?.result).toBe("processed");
  });

  // §8.6 第 5 条：apply 异常不发成功 ACK、不继续使用不可信实例，申请从 canonical snapshot 恢复。
  test("apply 抛异常时只发 rejected 并申请补齐，且弃用该 Doc 实例", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A);
    const broken = updateTask(DOC_A, 1, { payload: encodedPayload("boom").subarray(0, 3) });
    harness.hub.enqueue(broken);
    await harness.hub.drain();
    expect(harness.outcomes.filter((outcome) => outcome.result === "processed")).toHaveLength(1); // 仅基线
    expect(harness.outcomes[1]?.reason).toBe(APPLY_REJECT_REASONS.applyFailed);
    expect(harness.outcomes[1]?.result).toBe("rejected");
    expect(harness.resyncs).toHaveLength(1);
    expect(harness.resyncs[0]?.reason.startsWith(APPLY_REJECT_REASONS.applyFailed)).toBe(true);
    expect(harness.hub.loadedBytes()).toBe(0);
    harness.hub.enqueue(updateTask(DOC_A, 2));
    await harness.hub.drain();
    expect(harness.outcomes[2]?.reason).toBe(APPLY_REJECT_REASONS.baseNotReady);
  });

  // 候选实例的失败不牵连现役实例：从空应用的 snapshot 失败时，既有内容仍可供视图展示。
  test("候选 base 失败时保留现役实例的既有内容", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A);
    const resident = harness.hub.loadedBytes();
    harness.hub.enqueue(updateTask(DOC_A, 9)); // 缺口 → 基线作废但不丢内容
    await harness.hub.drain();
    expect(harness.hub.loadedBytes()).toBe(resident);
    harness.hub.enqueue(baseTask(DOC_A, { toSeq: 12, payload: encodedPayload("x").subarray(0, 2) }));
    await harness.hub.drain();
    expect(harness.hub.loadedBytes()).toBe(resident);
    expect(harness.resyncs).toHaveLength(2);
  });

  // 新 attempt 是重新协商的起点：旧 attempt 的排队帧作废并补 rejected，基线重置（§8.3/§8.4）；
  // 异 attempt 的增量则不得入队——BASE_READY 之后的 tail 只属于同一 attempt。
  test("新 attempt 的 base 作废旧 attempt 的排队帧并重置基线", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(baseTask(DOC_A, { toSeq: 4 }));
    await harness.hub.drain();
    const staleUpdate = updateTask(DOC_A, 1);
    harness.hub.enqueue(staleUpdate);
    const freshBase = baseTask(DOC_A, { syncAttemptId: SECOND_ATTEMPT, toSeq: 7 });
    harness.hub.enqueue(freshBase);
    expect(harness.outcomes[1]?.reason).toBe(APPLY_REJECT_REASONS.syncAttemptStale);
    expect(harness.outcomes[1]?.deliveryId).toBe(staleUpdate.deliveryId);
    expect(harness.hub.queueDepth()).toBe(1);
    await harness.hub.drain();
    expect(harness.outcomes[2]).toEqual({ deliveryId: freshBase.deliveryId, result: "processed" });
    harness.hub.enqueue(updateTask(DOC_A, 8, { syncAttemptId: SECOND_ATTEMPT }));
    expect(harness.hub.queueDepth()).toBe(1);
    await harness.hub.drain();
    expect(harness.outcomes[3]?.result).toBe("processed"); // 新 attempt 内从 toSeq 7 起的增量可应用
    harness.hub.enqueue(updateTask(DOC_A, 9)); // 旧 attempt 的迟到增量
    expect(harness.outcomes[4]?.reason).toBe(APPLY_REJECT_REASONS.syncAttemptStale);
    expect(harness.hub.queueDepth()).toBe(0);
  });

  // 无基线时 base 是「从空 Doc 应用完整 snapshot」：驻留字节等于新载荷，而不是与旧内容累加。
  test("新 attempt 的 base 替换而非合并既有内容", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A, 1);
    const payload = encodedPayload("replacement-content");
    harness.hub.enqueue(baseTask(DOC_A, { syncAttemptId: SECOND_ATTEMPT, toSeq: 2, payload }));
    await harness.hub.drain();
    expect(harness.hub.loadedBytes()).toBe(payload.byteLength);
    expect(harness.outcomes[1]?.result).toBe("processed");
  });
});

describe("sync doc hub 调度预算与让出执行权", () => {
  // 单次分片受次数上限约束，且分片之间必须让出执行权（否则等于把整个队列搬进一次同步调用）。
  test("maxTasks 限制单次分片并在分片之间让出执行权", async () => {
    const harness = createHarness({ budget: { maxBytes: 1_000_000, maxTasks: 2, maxMillis: 1_000_000 } });
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A);
    for (const seq of [1, 2, 3, 4, 5]) {
      harness.hub.enqueue(updateTask(DOC_A, seq));
    }
    await harness.hub.drain();
    expect(harness.yieldCount()).toBe(2);
    expect(processedDeliveryIds(harness.outcomes)).toHaveLength(6); // base + 5 条 update
  });

  // 字节预算是与条数预算独立的闸门：小条数、大载荷时也不能把整批塞进一个分片。
  test("maxBytes 限制单次分片", async () => {
    const payload = encodedPayload();
    const harness = createHarness({
      budget: { maxBytes: payload.byteLength * 2 + 1, maxTasks: 64, maxMillis: 1_000_000 },
    });
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A);
    for (const seq of [1, 2, 3, 4]) {
      harness.hub.enqueue(updateTask(DOC_A, seq, { payload }));
    }
    await harness.hub.drain();
    expect(harness.yieldCount()).toBe(1);
    expect(processedDeliveryIds(harness.outcomes)).toHaveLength(5);
  });

  // 时间预算只在两次 apply 之间生效；取时每次前进时每个分片恰好应用一条，队列仍全部推进。
  test("maxMillis 限制单次分片的时长", async () => {
    let ticks = 0;
    const harness = createHarness({
      now: () => (ticks += 10),
      budget: { maxBytes: 1_000_000, maxTasks: 64, maxMillis: 5 },
    });
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(baseTask(DOC_A, { toSeq: 0 }));
    await harness.hub.drain();
    for (const seq of [1, 2, 3]) {
      harness.hub.enqueue(updateTask(DOC_A, seq));
    }
    ticks = 0;
    await harness.hub.drain();
    expect(harness.yieldCount()).toBe(2); // 每个分片 1 条；最后一次让出发生在队列清空之前
    expect(processedDeliveryIds(harness.outcomes)).toHaveLength(4);
  });

  // 并发驱动必须合并：两个驱动交错会让同一 Doc 的任务乱序 apply。
  test("并发 drain 合并为同一次调度且不重复 apply", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(baseTask(DOC_A, { toSeq: 1 }));
    const first = harness.hub.drain();
    expect(harness.hub.drain()).toBe(first);
    await first;
    expect(harness.outcomes).toHaveLength(1);
  });

  // 调度期间新入队的任务在同一次调度内被处理，不需要调用方再触发一次（避免尾部长期滞留）。
  test("drain 期间入队的任务在同一次调度内处理", async () => {
    const outcomes: ApplyOutcome[] = [];
    const hub = createDocHub(
      hubOptions({
        onOutcome: (outcome) => {
          outcomes.push(outcome);
          if (outcomes.length === 2) hub.enqueue(updateTask(DOC_A, 2));
        },
      }),
    );
    hub.retain(DOC_A);
    hub.enqueue(baseTask(DOC_A, { toSeq: 0 }));
    await hub.drain();
    hub.enqueue(updateTask(DOC_A, 1));
    await hub.drain();
    expect(outcomes.map((outcome) => outcome.result)).toEqual(["processed", "processed", "processed"]);
  });
});

describe("sync doc hub 引用计数与生命周期", () => {
  // 已加载 Doc 按视图引用计数释放：计数未归零不得销毁，归零后不得继续接收投递；
  // 未配对的 release 会让计数漂移并把 Doc 泄漏给后续 retain，必须显式失败。
  test("retain/release 引用计数归零后才释放 Doc", async () => {
    const harness = createHarness();
    expect(() => harness.hub.release(DOC_B)).toThrow(/release without matching retain/);
    harness.hub.retain(DOC_A);
    harness.hub.retain(DOC_A);
    await prime(harness.hub, DOC_A, 1);
    const resident = harness.hub.loadedBytes();
    harness.hub.release(DOC_A);
    expect(harness.hub.loadedBytes()).toBe(resident);
    harness.hub.release(DOC_A);
    expect(harness.hub.loadedBytes()).toBe(0);
    harness.hub.enqueue(updateTask(DOC_A, 2));
    expect(harness.outcomes.at(-1)?.reason).toBe(APPLY_REJECT_REASONS.unknownDoc);
  });

  // 出队前 Doc 已被释放：帧已无归属，只结清传输额度，不再申请补齐（不会重新订阅）。
  test("出队前被释放的 Doc 的任务以 unknown-doc 结清", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(baseTask(DOC_A, { toSeq: 1 }));
    harness.hub.release(DOC_A);
    await harness.hub.drain();
    expect(harness.outcomes[0]?.reason).toBe(APPLY_REJECT_REASONS.unknownDoc);
    expect(harness.resyncs).toHaveLength(0);
    expect(harness.hub.loadedBytes()).toBe(0);
  });

  // dispose 是断连清账：Doc 与队列整体释放，之后不再回调消费方（账本由上层整体重置）。
  test("dispose 清理全部 Doc 与队列且不再回调", async () => {
    const harness = createHarness();
    harness.hub.retain(DOC_A);
    harness.hub.enqueue(baseTask(DOC_A, { toSeq: 1 }));
    harness.hub.dispose();
    await harness.hub.drain();
    harness.hub.enqueue(updateTask(DOC_A, 1));
    expect(harness.hub.queueDepth()).toBe(0);
    expect(harness.hub.loadedBytes()).toBe(0);
    expect(harness.outcomes).toHaveLength(0);
    expect(harness.resyncs).toHaveLength(0);
  });
});
