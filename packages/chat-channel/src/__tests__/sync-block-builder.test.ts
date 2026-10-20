// packages/chat-channel/src/__tests__/sync-block-builder.test.ts
// C2 单块构建的行为守护（规格 §5.4）：结构逐字、payload 保真、确定性、硬限重新分块与前缀契约。
//
// 这些断言是「canonical 字节」的可信度来源：一旦结构键、键序或 clientID 派生方式漂移，同内容重建就会
// 得到不同摘要，后续的幂等重放与冲突判定会在运行时静默失效——编译期看不出来，只能靠这里挡住。
// 构建期 Doc 的「构造 → 销毁」配对同样在此断言：遗漏 destroy 会按块数泄漏 Doc，并把临时 Doc 拖进广播路径。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { type BlockRecordInput, type BuiltBlock, buildContentBlock } from "../sync/history/block-builder";
import { SyncProtocolError } from "../sync/protocol/errors";
import { parseDocId } from "../sync/protocol/identity";

const textEncoder = new TextEncoder();

/** 读取侧视图：测试独立声明一次，用于验证「构建期结构 = 读取契约」，不 import 实现内部类型。 */
interface FlatRecordView {
  recordId: string;
  entryId: string;
  entryOrder: number;
  contentSlot: number;
  partIndex: number;
  kind: string;
  payload: Uint8Array;
}

/** Uint8Array 比较用视图：`toEqual` 对数组给出逐元素差异，比布尔比较更易定位。 */
function bytesOf(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

/** 构造一条记录输入；默认字段可被用例覆盖。 */
function record(
  sourceOrdinal: number,
  payload: Uint8Array,
  overrides: Partial<BlockRecordInput> = {},
): BlockRecordInput {
  return {
    sourceOrdinal,
    kind: "history_object",
    payload,
    entryId: `entry_${sourceOrdinal}`,
    entryOrder: sourceOrdinal,
    contentSlot: 0,
    partIndex: 0,
    ...overrides,
  };
}

/** 生成 count 条连续序号记录，载荷按序号可预测，便于断言顺序与内容一致。 */
function records(count: number, payloadBytes: number): BlockRecordInput[] {
  const out: BlockRecordInput[] = [];
  for (let index = 1; index <= count; index += 1) {
    const payload = Uint8Array.from({ length: payloadBytes }, (_, offset) => (index * 31 + offset) % 256);
    out.push(record(index, payload));
  }
  return out;
}

/** 以默认容量与固定随机源构建，只覆盖用例关心的入参。 */
function build(
  inputs: readonly BlockRecordInput[],
  overrides: Partial<Parameters<typeof buildContentBlock>[0]> = {},
): BuiltBlock {
  return buildContentBlock({
    generation: "gen_test",
    blockIndex: 0,
    records: inputs,
    targetPayloadBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockTargetPayloadBytes,
    hardLimitBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockHardBytes,
    rand: deterministicRandomSource("block-builder"),
    digest: sha256Digest,
    ...overrides,
  });
}

/** 把 canonical 字节应用到空 Doc 并读出 root 与 records；调用方负责 destroy。 */
function readBlock(snapshot: Uint8Array): { doc: Y.Doc; root: Y.Map<unknown>; records: unknown[] } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  const root = doc.getMap("root");
  const array = root.get("records") as Y.Array<unknown>;
  return { doc, root, records: array.toArray() };
}

/** 捕获同步协议错误并断言类型；返回错误对象以便继续断言 code / retryable。 */
function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw a SyncProtocolError, but it succeeded");
}

/**
 * 在 Y.Doc 原型上打桩统计「构造 → 销毁」配对，用于断言构建期 Doc 不泄漏。
 *
 * 用原型打桩而不是 `mock.module()`：只在本用例的同步窗口内生效，`restore()` 立即复位，
 * 不改变任何模块导出，也不影响同进程内的其它测试文件。`getMap` 被构建函数每个 Doc 调用一次，
 * 因此是「构建期创建了几个 Doc」的可靠代理。
 */
function installDocSpy(): { created: number; destroyed: Y.Doc[]; restore(): void } {
  const originalGetMap = Y.Doc.prototype.getMap;
  const originalDestroy = Y.Doc.prototype.destroy;
  const destroyed: Y.Doc[] = [];
  const spy = {
    created: 0,
    destroyed,
    restore(): void {
      Y.Doc.prototype.getMap = originalGetMap;
      Y.Doc.prototype.destroy = originalDestroy;
    },
  };
  Y.Doc.prototype.getMap = function spiedGetMap(this: Y.Doc, name: string): unknown {
    spy.created += 1;
    return originalGetMap.call(this, name);
  } as typeof originalGetMap;
  Y.Doc.prototype.destroy = function spiedDestroy(this: Y.Doc): void {
    destroyed.push(this);
    originalDestroy.call(this);
  };
  return spy;
}

describe("buildContentBlock：canonical 结构", () => {
  // 验证 root 键集/键序与 records 元素形状逐字符合规格，避免读取契约与构建期结构漂移。
  test("应用到空 Doc 后 root 键与 records 元素结构与规格 §5.4 逐字一致", () => {
    const built = build([record(1, textEncoder.encode("a")), record(2, new Uint8Array([0, 255]))]);
    const { doc, root, records: read } = readBlock(built.snapshot);
    try {
      expect([...root.keys()]).toEqual([
        "schemaVersion",
        "kind",
        "generation",
        "blockIndex",
        "ordinalStart",
        "ordinalEnd",
        "recordCount",
        "records",
      ]);
      expect(root.get("schemaVersion")).toBe(1);
      expect(root.get("kind")).toBe("content");
      expect(root.get("generation")).toBe("gen_test");
      expect(root.get("blockIndex")).toBe(0);
      expect(root.get("ordinalStart")).toBe(1);
      expect(root.get("ordinalEnd")).toBe(2);
      expect(root.get("recordCount")).toBe(2);
      expect(read.length).toBe(2);
      // 元素必须是扁平普通对象（不是 Y.Map/Y.Text），键序即编码序，换序会改变 canonical 字节。
      expect(Object.keys(read[0] as object)).toEqual([
        "recordId",
        "entryId",
        "entryOrder",
        "contentSlot",
        "partIndex",
        "kind",
        "payload",
      ]);
      expect(Object.getPrototypeOf(read[0])).toBe(Object.prototype);
      expect((read[0] as FlatRecordView).payload instanceof Uint8Array).toBe(true);
      expect((read[1] as FlatRecordView).kind).toBe("history_object");
      expect(built.recordCount).toBe(2);
      expect(built.dependsOn).toEqual([]);
    } finally {
      doc.destroy();
    }
  });

  // 载荷必须逐字节保真：内容权威是这些字节，任何编码期改写都会让客户端读到与源对象不同的内容。
  test("每条记录的 payload 字节与输入逐字节相同（含 0x00、0xFF 与非 ASCII 文本）", () => {
    const inputs = [
      record(1, new Uint8Array([0x00, 0xff, 0x01, 0xfe])),
      record(2, textEncoder.encode("中文🙂 content")),
      record(3, new Uint8Array([0x7f])),
    ];
    const built = build(inputs);
    const { doc, records: read } = readBlock(built.snapshot);
    try {
      expect(read.length).toBe(3);
      for (let index = 0; index < inputs.length; index += 1) {
        expect(bytesOf((read[index] as FlatRecordView).payload)).toEqual(bytesOf(inputs[index].payload));
      }
    } finally {
      doc.destroy();
    }
  });

  // 零字节载荷与分片字段必须原样往返：空片段是合法输入，contentSlot/partIndex 决定同消息内的位置。
  test("空载荷记录与 contentSlot/partIndex 原样往返", () => {
    const inputs = [
      record(1, new Uint8Array(), { contentSlot: 2, partIndex: 0, kind: "text_part" }),
      record(2, new Uint8Array([9]), { contentSlot: 2, partIndex: 1, kind: "text_part" }),
    ];
    const built = build(inputs);
    const { doc, records: read } = readBlock(built.snapshot);
    try {
      const first = read[0] as FlatRecordView;
      const second = read[1] as FlatRecordView;
      expect(first.payload.byteLength).toBe(0);
      expect([first.kind, first.contentSlot, first.partIndex]).toEqual(["text_part", 2, 0]);
      expect([second.kind, second.contentSlot, second.partIndex]).toEqual(["text_part", 2, 1]);
    } finally {
      doc.destroy();
    }
  });

  // records 元数据映射必须与输入一致：提交方据此写目录与 ref 索引，错位会让定位到错误记录。
  test("records 元数据（ordinal/entryId/顺序/字节区间/摘要）与输入记录一致", () => {
    const inputs = [record(7, new Uint8Array([1, 2, 3]), { entryId: "entry_a", entryOrder: 42 })];
    const built = build(inputs);
    const [entry] = built.records;
    expect(entry.ordinal).toBe(7);
    expect(entry.entryId).toBe("entry_a");
    expect([entry.orderStart, entry.orderEnd]).toEqual([42, 42]);
    expect([entry.byteStart, entry.byteEnd]).toEqual([0, 3]);
    expect(entry.digest).toBe(sha256Digest(inputs[0].payload));
    // recordId 由「序号 + 载荷摘要」派生：同内容重建得到同一 id，重复 apply 同一产物不会产生重复记录。
    expect(entry.recordId.startsWith("rec_7_")).toBe(true);
    expect(build(inputs).records[0].recordId).toBe(entry.recordId);
  });
});

describe("buildContentBlock：摘要与确定性", () => {
  // hash 必须就是注入摘要函数对 canonical 字节的取值，重新编码也要复现同一份字节（读取侧可自校验）。
  test("hash = digest(encodeStateAsUpdate) 且重新编码得到同一份字节", () => {
    const built = build(records(4, 16));
    expect(built.hash).toBe(sha256Digest(built.snapshot));
    const { doc } = readBlock(built.snapshot);
    try {
      expect(bytesOf(Y.encodeStateAsUpdate(doc))).toEqual(bytesOf(built.snapshot));
    } finally {
      doc.destroy();
    }
  });

  // stateVector 必须来自同一份 canonical 状态：客户端据它算差分，不匹配会请求到错误范围。
  test("stateVector 与读取侧重建出的 state vector 一致且非空", () => {
    const built = build(records(3, 8));
    const { doc } = readBlock(built.snapshot);
    try {
      expect(bytesOf(built.stateVector)).toEqual(bytesOf(Y.encodeStateVector(doc)));
      expect(built.stateVector.byteLength).toBeGreaterThan(0);
    } finally {
      doc.destroy();
    }
  });

  // 同内容重复构建必须逐字节相同：否则同 docId 同摘要的幂等重放与冲突判定全部失效（随机 clientID 是根因）。
  test("同一输入重复构建（不同随机种子）得到完全相同的 snapshot 与 hash", () => {
    const first = build(records(5, 24), { rand: deterministicRandomSource("seed-a") });
    const second = build(records(5, 24), { rand: deterministicRandomSource("seed-b") });
    expect(bytesOf(second.snapshot)).toEqual(bytesOf(first.snapshot));
    expect(second.hash).toBe(first.hash);
    expect(second.stateVector).toEqual(first.stateVector);
    // docId 的 nonce 每次构建都换新：身份按尝试区分，不得靠复用 guid 假装幂等。
    expect(second.docId).not.toBe(first.docId);
  });

  // docId 必须是可解析的 content 谱系标识，提交方与客户端都靠它定位块。
  test("docId 为 content 谱系的合法标识且 nonce 为 16 位十六进制", () => {
    const built = build(records(1, 4), { generation: "gen_lineage", blockIndex: 7 });
    const parts = parseDocId(built.docId);
    expect(parts.kind).toBe("content");
    expect(parts.generation).toBe("gen_lineage");
    expect(parts.blockIndex).toBe(7);
    expect(parts.nonce).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("buildContentBlock：分块与容量", () => {
  // ordinalStart/ordinalEnd/recordCount 必须与最终纳入的记录一致，单条记录时起止相等。
  test("ordinalStart/ordinalEnd/recordCount 与输入记录一致（单条时起止相等）", () => {
    const inputs = records(6, 4);
    const multi = build(inputs.slice(1));
    expect([multi.ordinalStart, multi.ordinalEnd, multi.recordCount]).toEqual([2, 6, 5]);
    const single = build(inputs.slice(5));
    expect([single.ordinalStart, single.ordinalEnd, single.recordCount]).toEqual([6, 6, 1]);
  });

  // 软水位只决定累积停止点：超出软水位的记录留给下一次调用，不得挤进同一块。
  test("按 targetPayloadBytes 累积到软水位即停止，剩余记录留给下一次构建", () => {
    const built = build(records(3, 100), { targetPayloadBytes: 100, hardLimitBytes: 262144 });
    expect(built.recordCount).toBe(1);
    expect(built.ordinalEnd).toBe(1);
  });

  // 编码超硬限时必须按记录边界重新分块：块编码 ≤ 硬限，且循环构建后记录一条不丢（前缀契约）。
  test("编码超硬限时按记录边界重新分块，产出块 ≤ 硬限且循环构建不丢记录", () => {
    // 小载荷 + 每记录固定编码开销：载荷总和在软水位内，编码后却超硬限，正好逼出重新分块路径。
    const inputs = records(20, 8);
    const limits = { targetPayloadBytes: 1000, hardLimitBytes: 1000 };
    const collected: number[] = [];
    let offset = 0;
    let blocks = 0;
    while (offset < inputs.length) {
      const built = build(inputs.slice(offset), limits);
      expect(built.snapshot.byteLength).toBeLessThanOrEqual(limits.hardLimitBytes);
      // 首次构建必须真的被缩小（否则说明重新定界没生效），且不得塌成「一条记录一块」。
      if (blocks === 0) {
        expect(built.recordCount).toBeGreaterThan(1);
        expect(built.recordCount).toBeLessThan(inputs.length);
      }
      collected.push(...built.records.map((entry) => entry.ordinal));
      offset += built.recordCount;
      blocks += 1;
      expect(blocks).toBeLessThanOrEqual(inputs.length);
    }
    expect(blocks).toBeGreaterThan(1);
    expect(collected).toEqual(inputs.map((entry) => entry.sourceOrdinal));
  });

  // 单条记录本身就超硬限时必须报容量错误：既不能拆已发布 CRDT，也不能靠网络分片遮蔽超大 snapshot。
  test("重新分块后单条记录仍超硬限时抛 CAPACITY_EXCEEDED 且标记为可重试", () => {
    const error = captureSyncError(() =>
      build([record(1, new Uint8Array(4096))], { targetPayloadBytes: 1024, hardLimitBytes: 1024 }),
    );
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.retryable).toBe(true);
    expect(error.safeContext.generation).toBe("gen_test");
  });

  // dependsOn 恒为空：内容块之间没有 CRDT 依赖，顺序由目录 ordinal 范围表达，上限只约束入口屏障。
  test("dependsOn 恒为空数组且不超过 dependsOnMax", () => {
    const built = build(records(3, 8));
    expect(built.dependsOn).toEqual([]);
    expect(built.dependsOn.length).toBeLessThanOrEqual(DEFAULT_SYNC_CAPACITY.inputs.dependsOnMax);
  });
});

describe("buildContentBlock：Doc 生命周期与输入校验", () => {
  // 构建期 Doc 必须在返回前销毁：否则每块泄漏一个 Doc，且活着的 Doc 会被误接进广播路径。
  test("构建期 Doc 在返回前已销毁，构造与销毁一一对应", () => {
    const spy = installDocSpy();
    let built: BuiltBlock;
    try {
      built = build(records(4, 32));
    } finally {
      spy.restore();
    }
    expect(built.snapshot.byteLength).toBeGreaterThan(0);
    expect(spy.created).toBe(1);
    expect(spy.destroyed.length).toBe(1);
    expect(spy.destroyed[0].isDestroyed).toBe(true);
  });

  // 重新分块路径一次调用会编码多次：每次尝试的 Doc 都必须销毁，构建期不得留下任何活着的 Doc。
  test("重新分块时的多次编码尝试同样逐个销毁 Doc", () => {
    const spy = installDocSpy();
    try {
      build(records(20, 8), { targetPayloadBytes: 1000, hardLimitBytes: 1000 });
    } finally {
      spy.restore();
    }
    expect(spy.created).toBeGreaterThan(1);
    expect(spy.destroyed.length).toBe(spy.created);
    expect(spy.destroyed.every((doc) => doc.isDestroyed)).toBe(true);
  });

  // 记录数超过单事务上限时必须分批写入且顺序不变，读回仍是同一串记录。
  test("超过单事务记录上限的记录仍全量往返且顺序不变", () => {
    const inputs = records(300, 4);
    const built = build(inputs);
    expect(built.recordCount).toBe(300);
    const { doc, records: read } = readBlock(built.snapshot);
    try {
      expect(read.length).toBe(300);
      const ordinals = read.map((entry) => (entry as FlatRecordView).entryOrder);
      expect(ordinals).toEqual(inputs.map((entry) => entry.entryOrder));
      expect(bytesOf((read[299] as FlatRecordView).payload)).toEqual(bytesOf(inputs[299].payload));
    } finally {
      doc.destroy();
    }
  });

  // 结构性输入错误一律 MALFORMED_FRAME（重试无意义）：空块、跳号、非字节载荷、非法 docId 段。
  test("结构性输入非法时抛 MALFORMED_FRAME", () => {
    const cases: { name: string; run: () => unknown }[] = [
      { name: "空记录", run: () => build([]) },
      { name: "序号跳号", run: () => build([record(1, new Uint8Array([1])), record(3, new Uint8Array([2]))]) },
      { name: "序号重复", run: () => build([record(1, new Uint8Array([1])), record(1, new Uint8Array([2]))]) },
      {
        name: "载荷非 Uint8Array",
        run: () => build([{ ...record(1, new Uint8Array([1])), payload: [1, 2, 3] } as unknown as BlockRecordInput]),
      },
      {
        name: "entryId 为空",
        run: () => build([record(1, new Uint8Array([1]), { entryId: "" })]),
      },
      { name: "generation 含路径分隔符", run: () => build(records(1, 4), { generation: "gen/bad" }) },
      { name: "blockIndex 为负", run: () => build(records(1, 4), { blockIndex: -1 }) },
    ];
    for (const item of cases) {
      const error = captureSyncError(item.run);
      expect(`${item.name}:${error.code}`).toBe(`${item.name}:MALFORMED_FRAME`);
    }
  });

  // 容量参数非法一律 ADMISSION_REJECTED（与容量配置校验同一口径），避免出现第二套失败类型。
  test("容量参数非法时抛 ADMISSION_REJECTED", () => {
    const cases: { name: string; run: () => unknown }[] = [
      { name: "目标为 0", run: () => build(records(1, 4), { targetPayloadBytes: 0 }) },
      { name: "硬限为负", run: () => build(records(1, 4), { hardLimitBytes: -1 }) },
      { name: "硬限非整数", run: () => build(records(1, 4), { hardLimitBytes: 1.5 }) },
      {
        name: "目标大于硬限",
        run: () => build(records(1, 4), { targetPayloadBytes: 4096, hardLimitBytes: 2048 }),
      },
    ];
    for (const item of cases) {
      const error = captureSyncError(item.run);
      expect(`${item.name}:${error.code}`).toBe(`${item.name}:ADMISSION_REJECTED`);
    }
  });
});
