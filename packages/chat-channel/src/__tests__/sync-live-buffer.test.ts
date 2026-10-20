import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, SERVER_POOL_BYTES } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource } from "../sync/clock";
import { createMergeBuffer, type MergeBuffer, type MergeFlushRequest, type MergeKey } from "../sync/live/merge-buffer";
import {
  createRotationController,
  type RotationController,
  type RotationControllerOptions,
} from "../sync/live/rotation";
import {
  CONTROL_DOC_LIMITS,
  createRuntimeDoc,
  type FinalEntityDescriptor,
  RUNTIME_DOC_LIMITS,
  type RuntimeDocLimits,
  type RuntimeEntityRecord,
} from "../sync/live/runtime-doc";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";

/** 注入式时钟：阈值断言全部由它推进；只有真实定时器用例才做真实等待（见该用例注释）。 */
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

const TEXT_ENCODER = new TextEncoder();

/** UTF-8 字节数：文本、元数据与实体存态都是字节口径，不能用 UTF-16 长度替代。 */
function utf8Bytes(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

/** 观察一次调用是否抛错：容量边界用例要区分「成功」与「被拒」，而不是只断言抛不抛。 */
function catchSyncError(run: () => unknown): SyncProtocolError | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
}

function expectSyncErrorCode(run: () => unknown, code: SyncErrorCode): SyncProtocolError {
  const error = catchSyncError(run);
  if (error === null) {
    throw new Error(`expected SyncProtocolError ${code} to be thrown`);
  }
  expect(error.code).toBe(code);
  return error;
}

const BASE_KEY: MergeKey = {
  generation: "gen_1",
  turnId: "turn_1",
  entryId: "entry_1",
  contentSlot: "text",
  contentType: "text/plain",
};

type MergeHarness = { readonly buffer: MergeBuffer; readonly flushes: MergeFlushRequest[] };

function mergeHarness(clock: Clock, options: { maxDelayMs?: number; maxBytes?: number } = {}): MergeHarness {
  const flushes: MergeFlushRequest[] = [];
  const buffer = createMergeBuffer({
    clock,
    maxDelayMs: options.maxDelayMs ?? 10_000,
    maxBytes: options.maxBytes ?? 1024 * 1024,
    onFlush: (request) => flushes.push(request),
  });
  return { buffer, flushes };
}

/** 元数据 JSON 恰好 `bytes` 字节（ASCII），用于钉 1KiB 与聚合上限的精确边界。 */
function padding(bytes: number): Record<string, unknown> {
  return { pad: "x".repeat(bytes - 10) }; // `{"pad":""}` 的固定开销为 10 字节
}

function openEntity(index: number, metadata: Record<string, unknown> = { name: "read" }): RuntimeEntityRecord {
  const suffix = String(index).padStart(3, "0");
  return { entityId: `entity-${suffix}`, kind: "tool", toolCallId: `call-${suffix}`, metadata, state: "open" };
}

function descriptorOf(entityId: string): FinalEntityDescriptor {
  return {
    entityId,
    kind: "tool",
    contentRef: `content/${entityId}`,
    digest: "a".repeat(64),
    byteLength: 4096,
    completedAt: 1_000,
  };
}

function finalEntity(entityId: string, metadata: Record<string, unknown> = { result: "ok" }): RuntimeEntityRecord {
  return {
    entityId,
    kind: "tool",
    toolCallId: `call-${entityId}`,
    metadata,
    state: "final",
    finalDescriptor: descriptorOf(entityId),
  };
}

function makeRotation(clock: Clock, overrides: Partial<RotationControllerOptions> = {}): RotationController {
  return createRotationController({
    clock,
    random: deterministicRandomSource("rotation"),
    limits: RUNTIME_DOC_LIMITS,
    maxResidentMs: 60_000,
    maxTransactions: 100,
    ...overrides,
  });
}

describe("合并缓冲（设计 §6.1）", () => {
  // 合并键五项任一不同都不得合并：拼错键等于把不同消息、或工具前后的文本写进同一条记录。
  test("合并键五项任一不同都必须先冲刷", () => {
    const variants: readonly [string, MergeKey][] = [
      ["generation", { ...BASE_KEY, generation: "gen_2" }],
      ["turnId", { ...BASE_KEY, turnId: "turn_2" }],
      ["entryId", { ...BASE_KEY, entryId: "entry_2" }],
      ["contentSlot", { ...BASE_KEY, contentSlot: "reasoning" }],
      ["contentType", { ...BASE_KEY, contentType: "text/markdown" }],
    ];
    for (const [field, variant] of variants) {
      const { buffer, flushes } = mergeHarness(new TestClock());
      buffer.push(BASE_KEY, "first");
      buffer.push(variant, "second");
      expect(`${field}:${flushes.length}`).toBe(`${field}:1`);
      expect(flushes[0]?.text).toBe("first");
      expect(flushes[0]?.key).toEqual(BASE_KEY);
      expect(flushes[0]?.key).not.toBe(BASE_KEY); // 存的是键的副本，调用方后续改写不得影响缓冲
      expect(buffer.pendingKeys()).toBe(1);
      buffer.dispose();
    }
  });

  // 同一键的文本必须原样拼接：任何 trim 或规范化都会改变用户可见内容；字节数是 UTF-8 口径。
  test("同一键文本原样拼接，字节按 UTF-8 计", () => {
    const { buffer, flushes } = mergeHarness(new TestClock());
    const text = "  a\n中文🙂 ";
    buffer.push(BASE_KEY, ""); // 空增量不产生文本，也不起算时间阈值
    expect(buffer.pendingKeys()).toBe(0);
    buffer.push(BASE_KEY, "  a\n");
    buffer.push(BASE_KEY, "中文🙂 ");
    expect(flushes).toEqual([]);
    buffer.barrier(BASE_KEY);
    expect(flushes[0]?.text).toBe(text);
    expect(flushes[0]?.bytes).toBe(utf8Bytes(text));
    expect(flushes[0]?.bytes).not.toBe(text.length);
  });

  // 字节阈值到达即提交：不等定时器，缓冲不允许越过上限继续增长。
  test("字节阈值到达即时冲刷", () => {
    const { buffer, flushes } = mergeHarness(new TestClock(), { maxBytes: 8 });
    buffer.push(BASE_KEY, "12345");
    expect(buffer.pendingKeys()).toBe(1);
    buffer.push(BASE_KEY, "678");
    expect(flushes.length).toBe(1);
    expect(flushes[0]?.text).toBe("12345678");
    expect(flushes[0]?.bytes).toBe(8);
    expect(buffer.pendingKeys()).toBe(0);
    buffer.dispose();
  });

  // 定时器只从首增量起算：trailing debounce 会被持续输出无限推迟，提交退化成「输出结束才提交」。
  test("定时器从首增量起算，不因后续增量推迟", async () => {
    const { buffer, flushes } = mergeHarness(new TestClock(), { maxDelayMs: 10 });
    buffer.push(BASE_KEY, "a");
    // 真实等待是为了观察真实定时器（注入 Clock 只驱动阈值判定）；两次共 ~40ms。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushes.map((request) => request.text)).toEqual(["a"]);
    buffer.push(BASE_KEY, "b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 若定时器被第二个增量重设，这里只会看到 "ab"；实际必须是两个独立窗口。
    expect(flushes.map((request) => request.text)).toEqual(["a", "b"]);
    buffer.dispose();
  });

  // 屏障必须同步可完成且对同键幂等：调用方在返回后即可推进语义状态，且不得重复提交同一文本。
  test("barrier 对同键幂等、同步可完成，且不冲刷异键缓冲", () => {
    const { buffer, flushes } = mergeHarness(new TestClock());
    buffer.push(BASE_KEY, "a");
    buffer.barrier(BASE_KEY);
    expect(flushes.map((request) => request.text)).toEqual(["a"]);
    buffer.barrier(BASE_KEY);
    buffer.barrier(BASE_KEY);
    expect(flushes.length).toBe(1);
    buffer.push(BASE_KEY, "b");
    buffer.barrier({ ...BASE_KEY, turnId: "turn_2" });
    expect(flushes.length).toBe(1);
    buffer.push(BASE_KEY, "c");
    buffer.barrier();
    expect(flushes.map((request) => request.text)).toEqual(["a", "bc"]);
    expect(buffer.pendingKeys()).toBe(0);
  });

  // 截止时间已过但定时器尚未回调时，下一次 push 必须先提交旧文本，不与新窗口合并。
  test("时钟已过截止时间时先提交旧文本，再开新窗口", () => {
    const clock = new TestClock(1_000);
    const { buffer, flushes } = mergeHarness(clock, { maxDelayMs: 5 });
    buffer.push(BASE_KEY, "a");
    clock.advance(5);
    buffer.push(BASE_KEY, "b");
    expect(flushes.map((request) => request.text)).toEqual(["a"]);
    expect(flushes[0]?.firstArrivalAt).toBe(1_000);
    buffer.barrier(BASE_KEY);
    expect(flushes.map((request) => request.text)).toEqual(["a", "b"]);
    expect(flushes[1]?.firstArrivalAt).toBe(1_005);
    expect(flushes[1]?.lastArrivalAt).toBe(1_005);
    buffer.dispose();
  });

  // 释放路径丢弃未提交文本且不再回调（Doc 通常已封口）；dispose 后继续 push 必须显式失败。
  test("dispose 丢弃未提交文本，其后 push 失败而非静默丢文本", () => {
    const { buffer, flushes } = mergeHarness(new TestClock());
    buffer.push(BASE_KEY, "a");
    buffer.dispose();
    buffer.dispose();
    expect(buffer.pendingKeys()).toBe(0);
    expect(flushes.length).toBe(0);
    expectSyncErrorCode(() => buffer.push(BASE_KEY, "b"), "RESOURCE_RETIRED");
    buffer.flushAll();
    buffer.barrier();
    expect(flushes.length).toBe(0);
  });

  // 阈值是容量参数：非法值必须在构造期失败，而不是第一次 push 时才暴露。
  test("阈值非法时抛 ADMISSION_REJECTED", () => {
    for (const bad of [0, -1, 1.5]) {
      expectSyncErrorCode(() => mergeHarness(new TestClock(), { maxDelayMs: bad }), "ADMISSION_REJECTED");
      expectSyncErrorCode(() => mergeHarness(new TestClock(), { maxBytes: bad }), "ADMISSION_REJECTED");
    }
  });
});

describe("运行态 Doc（设计 §6.2 / §6.3）", () => {
  // 上限是评审冻结的验收基线，用字面量锁定：调参必须伴随评审记录，不能就地改写。
  test("RUNTIME_DOC_LIMITS 与 CONTROL_DOC_LIMITS 逐字落地", () => {
    expect(RUNTIME_DOC_LIMITS).toEqual({
      maxLivePayloadBytes: 65536,
      maxEntities: 256,
      maxEntityMetadataBytes: 1024,
      softRotateBytes: 131072,
      // 由数据帧上限反推：任何可提交 Doc 都必须能由空客户端以单帧重建。
      hardLimitBytes: 218100,
    });
    expect(CONTROL_DOC_LIMITS).toEqual({ entryBytes: 8192, softBytes: 32768, hardBytes: 65536 });
  });

  // 实体数上限 256：第 257 个新实体被拒，但更新已有实体不受限（否则满载 Doc 连状态更新都做不了）。
  test("实体数上限 256 的边界", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    for (let index = 0; index < 256; index += 1) {
      doc.upsertEntity(openEntity(index));
    }
    expect(doc.entityCount()).toBe(256);
    const error = expectSyncErrorCode(() => doc.upsertEntity(openEntity(256)), "CAPACITY_EXCEEDED");
    expect(error.message).toContain("256");
    doc.upsertEntity(openEntity(0, { name: "updated" }));
    expect(doc.entityCount()).toBe(256);
    expect(doc.exportForRotation()[0]?.metadata).toEqual({ name: "updated" });
  });

  // 单实体元数据 1KiB 边界：1024 字节通过，1025 字节必须在写入前失败（大参数要外置为内容块）。
  test("单实体元数据 1KiB 的边界", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    const maxMetadata = padding(RUNTIME_DOC_LIMITS.maxEntityMetadataBytes);
    expect(utf8Bytes(JSON.stringify(maxMetadata))).toBe(1024);
    doc.upsertEntity(openEntity(1, maxMetadata));
    expectSyncErrorCode(() => doc.upsertEntity(openEntity(2, padding(1025))), "CAPACITY_EXCEEDED");
    expect(doc.entityCount()).toBe(1);
  });

  // 存活载荷上限的边界：额度是注入参数，用小额度把「刚好达标 / 再多一字节即拒绝」钉死。
  test("存活载荷上限的边界与替换后重算", () => {
    const probe = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    probe.upsertEntity(openEntity(0));
    const perEntity = utf8Bytes(JSON.stringify(probe.exportForRotation()[0]));
    const limits: RuntimeDocLimits = { ...RUNTIME_DOC_LIMITS, maxLivePayloadBytes: perEntity * 4 };
    const doc = createRuntimeDoc("runtime", limits);
    for (let index = 0; index < 4; index += 1) {
      doc.upsertEntity(openEntity(index));
    }
    expect(doc.entityCount()).toBe(4);
    expectSyncErrorCode(() => doc.upsertEntity(openEntity(4)), "CAPACITY_EXCEEDED");
    doc.upsertEntity(openEntity(0)); // 同尺寸替换仍恰好达标
    expectSyncErrorCode(() => doc.upsertEntity(openEntity(0, { name: "read1" })), "CAPACITY_EXCEEDED");
    expect(doc.entityCount()).toBe(4);
  });

  // 元数据取满 1KiB 时，64KiB 聚合上限先于 256 实体上限触发：容量错误不能被实体数上限掩盖。
  test("元数据取满时 64KiB 聚合先于实体数上限触发", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    let accepted = 0;
    for (let index = 0; index < RUNTIME_DOC_LIMITS.maxEntities; index += 1) {
      const error = catchSyncError(() => doc.upsertEntity(openEntity(index, padding(1024))));
      if (error !== null) {
        expect(error.code).toBe("CAPACITY_EXCEEDED");
        break;
      }
      accepted += 1;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(RUNTIME_DOC_LIMITS.maxEntities);
    const used = doc.exportForRotation().reduce((sum, record) => sum + utf8Bytes(JSON.stringify(record)), 0);
    expect(used).toBeLessThanOrEqual(RUNTIME_DOC_LIMITS.maxLivePayloadBytes);
    expect(doc.entityCount()).toBe(accepted);
  });

  // final 与终态描述符必须成对且同属一个实体（设计 §6.2）：缺描述符的 final 实体会在客户端表现为消失。
  test("final 状态与终态描述符必须成对且同属一个实体", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    const invalid: readonly RuntimeEntityRecord[] = [
      { ...finalEntity("e-1"), finalDescriptor: undefined },
      { ...openEntity(1), finalDescriptor: descriptorOf("entity-001") },
      { ...finalEntity("e-1"), finalDescriptor: descriptorOf("e-2") },
      { ...finalEntity("e-1"), finalDescriptor: { ...descriptorOf("e-1"), kind: "permission" } },
      { ...finalEntity("e-1"), finalDescriptor: { ...descriptorOf("e-1"), byteLength: -1 } },
    ];
    for (const record of invalid) expectSyncErrorCode(() => doc.upsertEntity(record), "MALFORMED_FRAME");
    doc.upsertEntity(finalEntity("e-1"));
    expect(doc.entityCount()).toBe(1);
  });

  // 移除实体返回终态描述符并幂等：未登记与无描述符都返回 null，两者都不代表可交接的定位信息。
  test("removeEntity 返回终态描述符且幂等", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    doc.upsertEntity(finalEntity("e-1"));
    expect(doc.removeEntity("e-1")).toEqual(descriptorOf("e-1"));
    expect(doc.entityCount()).toBe(0);
    expect(doc.removeEntity("e-1")).toBeNull();
    doc.upsertEntity(openEntity(1));
    expect(doc.removeEntity("entity-001")).toBeNull();
    expect(doc.entityCount()).toBe(0);
  });

  // 轮换复制未结束与交接未完成的实体，且必须返回副本：返回值被改写不得污染当前文档。
  test("exportForRotation 复制待交接实体并返回副本", () => {
    const doc = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS);
    doc.upsertEntity(openEntity(1));
    doc.upsertEntity(finalEntity("e-2"));
    const exported = doc.exportForRotation();
    expect(exported.map((record) => record.entityId)).toEqual(["entity-001", "e-2"]);
    expect(exported[1]?.finalDescriptor?.contentRef).toBe("content/e-2");
    const [first] = exported;
    first.metadata.pad = "tampered";
    expect(doc.exportForRotation()[0]?.metadata).toEqual({ name: "read" });
    doc.removeEntity("e-2");
    expect(doc.exportForRotation().map((record) => record.entityId)).toEqual(["entity-001"]);
  });

  // 注入既有 Y.Doc 是恢复路径：实体表必须从已提交字节恢复，而不是依赖旧写者的内存。
  test("注入既有 Y.Doc 后实体表可用", () => {
    const source = new Y.Doc();
    const origin = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, source);
    origin.upsertEntity(openEntity(1));
    origin.upsertEntity(finalEntity("e-2"));

    const restoredDoc = new Y.Doc();
    Y.applyUpdate(restoredDoc, Y.encodeStateAsUpdate(source));
    const restored = createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, restoredDoc);
    expect(restored.entityCount()).toBe(2);
    expect(restored.exportForRotation().map((record) => record.entityId)).toEqual(["entity-001", "e-2"]);
    expect(restored.removeEntity("e-2")).toEqual(descriptorOf("e-2"));
    expect(restored.entityCount()).toBe(1);
  });

  // 反复开设与移除实体（键在变）会留下 GC 结构：存活实体只有 1 个，编码状态照样增长（设计 §6.3）。
  test("反复开设与移除实体仍累积编码状态并触发软水位", () => {
    const limits: RuntimeDocLimits = { ...RUNTIME_DOC_LIMITS, softRotateBytes: 4096 };
    const doc = createRuntimeDoc("runtime", limits);
    doc.upsertEntity(openEntity(0));
    const baseline = doc.encodedBytes();
    expect(doc.shouldRotate()).toBe(false);
    for (let round = 1; round <= 300; round += 1) {
      doc.upsertEntity(openEntity(round));
      doc.removeEntity(`entity-${String(round).padStart(3, "0")}`);
    }
    expect(doc.entityCount()).toBe(1);
    expect(doc.encodedBytes()).toBeGreaterThan(baseline + limits.softRotateBytes);
    expect(doc.shouldRotate()).toBe(true);
  });
});

describe("轮换决策与共存额度（设计 §6.3 / §10.1）", () => {
  // size-soft：实测编码状态或写前预估载荷到软水位即轮换（设计 §6.1「写前预估」），未到不轮换。
  test("size-soft：编码状态与写前预估载荷到软水位即轮换", () => {
    const soft = RUNTIME_DOC_LIMITS.softRotateBytes;
    const rotation = makeRotation(new TestClock());
    expect(rotation.evaluate({ encodedBytes: soft - 1, entityCount: 1 })).toEqual({ rotate: false });
    expect(rotation.evaluate({ encodedBytes: soft, entityCount: 1 })).toEqual({ rotate: true, reason: "size-soft" });
    const ahead = makeRotation(new TestClock());
    ahead.onTransaction(soft - 1);
    expect(ahead.evaluate({ encodedBytes: 0, entityCount: 1 })).toEqual({ rotate: false });
    ahead.onTransaction(1);
    expect(ahead.evaluate({ encodedBytes: 0, entityCount: 1 })).toEqual({ rotate: true, reason: "size-soft" });
  });

  // deadline：驻留到 maxResidentMs 即轮换，reset（新 Doc 已交接）后重新起算。
  test("deadline：驻留超时轮换且 reset 后重新起算", () => {
    const clock = new TestClock(1_000);
    const rotation = makeRotation(clock, { maxResidentMs: 1_000 });
    clock.advance(999);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 1 })).toEqual({ rotate: false });
    clock.advance(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 1 })).toEqual({ rotate: true, reason: "deadline" });
    rotation.reset();
    clock.advance(999);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 1 })).toEqual({ rotate: false });
    clock.advance(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 1 }).reason).toBe("deadline");
  });

  // transaction-count：累计事务数到上限即轮换，reset 归零。
  test("transaction-count：累计事务数到上限即轮换", () => {
    const rotation = makeRotation(new TestClock(), { maxTransactions: 3 });
    rotation.onTransaction(1);
    rotation.onTransaction(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 1 })).toEqual({ rotate: false });
    rotation.onTransaction(1);
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 1 }).reason).toBe("transaction-count");
    rotation.reset();
    expect(rotation.evaluate({ encodedBytes: 0, entityCount: 1 })).toEqual({ rotate: false });
  });

  // 理由优先级固定为 size-soft → deadline → transaction-count：理由要能解释为什么在这里换 Doc。
  test("三个理由同时成立时按固定优先级给出理由", () => {
    const clock = new TestClock(1_000);
    const allThree = makeRotation(clock, { maxResidentMs: 1, maxTransactions: 1 });
    allThree.onTransaction(RUNTIME_DOC_LIMITS.softRotateBytes);
    clock.advance(1);
    const soft = RUNTIME_DOC_LIMITS.softRotateBytes;
    expect(allThree.evaluate({ encodedBytes: soft, entityCount: 256 }).reason).toBe("size-soft");
    const deadlineFirst = makeRotation(clock, { maxResidentMs: 1, maxTransactions: 1 });
    deadlineFirst.onTransaction(0);
    clock.advance(1);
    expect(deadlineFirst.evaluate({ encodedBytes: 0, entityCount: 1 }).reason).toBe("deadline");
  });

  // 共存额度记在 hotDocLive：reset（交接完成）归还；同一轮换重放同一额度幂等，换额度报容量错误。
  test("共存额度计入 hotDocLive、重放幂等、换额度报容量错误", () => {
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const rotation = makeRotation(new TestClock());
    expect(admission.used("hotDocLive")).toBe(0);
    rotation.reserveCoexistence(admission, 4096);
    rotation.reserveCoexistence(admission, 4096);
    expect(admission.used("hotDocLive")).toBe(4096);
    expectSyncErrorCode(() => rotation.reserveCoexistence(admission, 8192), "CAPACITY_EXCEEDED");
    expect(admission.used("hotDocLive")).toBe(4096);
    rotation.reset();
    expect(admission.used("hotDocLive")).toBe(0);
  });

  // 额度不足时准入层拒绝原样传播（容量错误 = 可重试的瞬态过载），且不得留下占用。
  test("共存额度不足时抛容量错误且不产生占用", () => {
    const pools = { ...SERVER_POOL_BYTES, hotDocLive: 1024 };
    const admission = new AdmissionController({ ...DEFAULT_SYNC_CAPACITY, serverPools: pools });
    const attempt = () => makeRotation(new TestClock()).reserveCoexistence(admission, 2048);
    expect(expectSyncErrorCode(attempt, "ADMISSION_REJECTED").retryable).toBe(true);
    expect(admission.used("hotDocLive")).toBe(0);
    expect(admission.available("hotDocLive")).toBe(1024);
  });

  // 共存额度与轮换阈值、事务字节必须是正安全整数：0 或负数会让「预留—释放」凭空造出额度。
  test("共存额度与轮换参数非法时抛 ADMISSION_REJECTED", () => {
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const rotation = makeRotation(new TestClock());
    for (const bad of [0, -1, 1.5]) {
      expectSyncErrorCode(() => rotation.reserveCoexistence(admission, bad), "ADMISSION_REJECTED");
    }
    // 事务字节允许为 0（空写入仍计一次事务），负数与小数才是非法。
    rotation.onTransaction(0);
    for (const bad of [-1, 1.5]) expectSyncErrorCode(() => rotation.onTransaction(bad), "ADMISSION_REJECTED");
    for (const bad of [0, -1]) {
      expectSyncErrorCode(() => makeRotation(new TestClock(), { maxResidentMs: bad }), "ADMISSION_REJECTED");
      expectSyncErrorCode(() => makeRotation(new TestClock(), { maxTransactions: bad }), "ADMISSION_REJECTED");
    }
    expectSyncErrorCode(() => rotation.onTransaction(Number.MAX_SAFE_INTEGER + 1), "ADMISSION_REJECTED");
    expect(admission.used("hotDocLive")).toBe(0);
  });
});
