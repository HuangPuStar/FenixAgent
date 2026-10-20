// packages/chat-channel/src/__tests__/sync-ingest.test.ts
// 入口接收（规格 §5.3）的行为验收：编号、去重、边界冻结、有界扫描、大帧单任务路径与额度、暂存保真往返。
// 全部走真实文件系统（`os.tmpdir` + `mkdtemp`）与固定时间源；大帧阈值、扫描上限与配额压到测试尺度注入。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { type Clock, sha256Digest } from "../sync/clock";
import { fidelityDeserialize, fidelitySerialize } from "../sync/history/fidelity-json";
import { HistoryIngest, type HistoryRecordMeta, type IngestedRecord } from "../sync/history/ingest";
import { HistorySpool, type SpoolConfig } from "../sync/history/spool";
import { SyncProtocolError } from "../sync/protocol/errors";

const FIXED_NOW = 1_700_000_000_000;
const SCOPE_KEY = "org_ingest/rcs_ingest";
const GENERATION = "gen_ingest_0001";
const LOAD_ID = "load_ingest_0001";
/** 暂存配置只改配额档位，段大小与任务/进程上限都取小值，避免用例真写 2GiB 级数据。 */
const SPOOL_CONFIG: SpoolConfig = { basePath: "", segmentBytes: 256, taskQuotaBytes: 4096, processQuotaBytes: 8192 };

/** 时间源固定：失败诊断里的「已接收时长」必须确定，不依赖真实时钟。 */
const fixedClock: Clock = { now: () => FIXED_NOW };

/** 本文件创建的临时根目录；用例结束整体删除，避免把暂存残留留在系统临时目录里。 */
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 建一个空临时根目录，返回其下尚未创建的 `spool` 子目录路径（目录由暂存器按需创建）。 */
async function createBasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sync-ingest-"));
  tempRoots.push(root);
  return join(root, "spool");
}

interface Harness {
  ingest: HistoryIngest;
  spool: HistorySpool;
  admission: AdmissionController;
  profile: SyncCapacityProfile;
}

/** 测试用 profile：只覆盖输入上限（大帧阈值、深度、节点数），池数值保持默认，额度断言才能按默认值核对。 */
function testProfile(inputs: Partial<SyncCapacityProfile["inputs"]> = {}): SyncCapacityProfile {
  return { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, ...inputs } };
}

/** 建暂存器 + 准入账目 + 接收器；`admission: false` 用于验证「缺配置拒绝启用」的大帧分支。 */
async function createHarness(
  options: { inputs?: Partial<SyncCapacityProfile["inputs"]>; spool?: Partial<SpoolConfig>; admission?: boolean } = {},
): Promise<Harness> {
  const profile = testProfile(options.inputs);
  const basePath = await createBasePath();
  const spool = new HistorySpool({ ...SPOOL_CONFIG, basePath, ...options.spool }, fixedClock);
  const admission = new AdmissionController(profile);
  const deps = { spool, clock: fixedClock, digest: sha256Digest, capacity: profile };
  return {
    ingest: new HistoryIngest(options.admission === false ? deps : { ...deps, admission }),
    spool,
    admission,
    profile,
  };
}

/** 打开接收窗口：多数用例的统一起点。 */
async function begin(ingest: HistoryIngest): Promise<void> {
  await ingest.begin({ scopeKey: SCOPE_KEY, generation: GENERATION, loadId: LOAD_ID });
}

/** 捕获同步协议错误：非本层异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
async function captureIngestError(run: () => unknown): Promise<SyncProtocolError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

/**
 * 记录头来自不可信调用方，字段越界在类型层无法表达，只能从 JSON 还原：
 * 本用例用它构造「kind 未知、entryId 为空、片段号为负」等运行期坏输入。
 */
function runtimeMeta(json: string): HistoryRecordMeta {
  return JSON.parse(json) as HistoryRecordMeta;
}

/** 按「保真字节首尾相接、无 framing」的布局算出某个 ordinal 的区间，与接收器的内部索引互为对照。 */
function rangeOf(records: IngestedRecord[], ordinal: number): { offset: number; length: number } {
  let offset = 0;
  for (const record of records) {
    if (record.sourceOrdinal === ordinal) {
      return { offset, length: record.payloadBytes };
    }
    offset += record.payloadBytes;
  }
  throw new Error(`ordinal ${ordinal} was not accepted`);
}

describe("编号与窗口", () => {
  // ordinal 是「本次 load 内对象顺序」的唯一来源，必须从 1 起连续，否则目录的连续范围与缺口判定都会失准。
  test("顺序编号从 1 开始且连续", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const first = await ingest.accept({ text: "第一条" }, { kind: "history_object", entryId: "entry_1" });
    const second = await ingest.accept({ text: "第二条" }, { kind: "history_object", entryId: "entry_2" });
    const third = await ingest.accept({ text: "第三条" }, { kind: "history_object", entryId: "entry_3" });
    expect([first.sourceOrdinal, second.sourceOrdinal, third.sourceOrdinal]).toEqual([1, 2, 3]);
    expect(first.loadId).toBe(LOAD_ID);
    expect(first.generation).toBe(GENERATION);
    expect(ingest.status()).toEqual({
      state: "receiving",
      objectCount: 3,
      lastOrdinal: 3,
      totalBytes: first.payloadBytes + second.payloadBytes + third.payloadBytes,
    });
  });

  // 内容相同不等于同一对象：没有稳定源身份时不启用去重，两条内容一样的消息都必须保留（设计 §5.3）。
  test("内容相同的两个对象都保留", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const first = await ingest.accept("同一条消息", { kind: "history_object", entryId: "entry_a" });
    const second = await ingest.accept("同一条消息", { kind: "history_object", entryId: "entry_b" });
    expect([first.sourceOrdinal, second.sourceOrdinal]).toEqual([1, 2]);
    expect(first.digest).toBe(second.digest);
    expect(ingest.status().objectCount).toBe(2);
    expect(await ingest.readRecord(1)).toEqual(await ingest.readRecord(2));
  });

  // 缺省 entryId 时没有可判定身份，同样不去重：宁可重复落两条，也不能让对象在编号空间里消失。
  test("缺省 entryId 的记录不参与去重", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const first = await ingest.accept({ text: "x" }, { kind: "history_object" });
    const second = await ingest.accept({ text: "x" }, { kind: "history_object" });
    expect([first.sourceOrdinal, second.sourceOrdinal]).toEqual([1, 2]);
  });

  // 窗口未打开时对象没有归属（没有 loadId/generation 可绑定），必须失败而不是静默丢弃。
  test("未 begin 时 accept 被拒且状态保持空闲", async () => {
    const { ingest } = await createHarness();
    const error = await captureIngestError(() =>
      ingest.accept({ a: 1 }, { kind: "history_object", entryId: "entry_1" }),
    );
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(ingest.status()).toEqual({ state: "idle", objectCount: 0, lastOrdinal: 0, totalBytes: 0 });
  });

  // 边界冻结后再接收属于下一次 load（设计 §5.3 [R5]）：必须拒绝，不能把迟到对象接进已冻结的编号空间。
  test("markReceivingComplete 后 accept 抛 IMPORT_INCOMPLETE", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const record = await ingest.accept({ text: "唯一一条" }, { kind: "history_object", entryId: "entry_1" });
    ingest.markReceivingComplete(1);
    const error = await captureIngestError(() =>
      ingest.accept({ text: "迟到" }, { kind: "history_object", entryId: "entry_2" }),
    );
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(ingest.status()).toEqual({
      state: "receivingComplete",
      objectCount: 1,
      lastOrdinal: 1,
      totalBytes: record.payloadBytes,
    });
  });

  // 边界与「同一有序接收入口」的最后一个编号必须一致：更小会丢已接收对象，更大说明对象没到齐，两者都不能冻。
  test("接收边界与已接收编号不一致时拒绝冻结", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    await ingest.accept({ text: "第一条" }, { kind: "history_object", entryId: "entry_1" });
    const error = await captureIngestError(() => ingest.markReceivingComplete(2));
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(ingest.status().state).toBe("receiving");
    ingest.markReceivingComplete(1);
    expect(ingest.status().state).toBe("receivingComplete");
  });

  // 在途对象已拿到编号但还没进索引：此刻冻结会让构建漏掉它，必须先等它落盘（§5.3 [R5] 先编号再分派）。
  test("在途对象未落盘时不得冻结边界", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const pending = ingest.accept({ text: "在途" }, { kind: "history_object", entryId: "entry_1" });
    const error = await captureIngestError(() => ingest.markReceivingComplete(1));
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect((await pending).sourceOrdinal).toBe(1);
    ingest.markReceivingComplete(1);
    expect(ingest.status().state).toBe("receivingComplete");
  });

  // 同一对象二次提交必须被拒：重复会伪造时间线；被拒的提交不消耗编号，后续编号才保持连续。
  test("同一身份二次提交被拒且不消耗编号", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const meta: HistoryRecordMeta = { kind: "text_part", entryId: "entry_1", contentSlot: 0, partIndex: 0 };
    const first = await ingest.accept("片段", meta);
    const error = await captureIngestError(() => ingest.accept("片段", meta));
    expect(error.code).toBe("DUPLICATE_OBJECT");
    expect(error.safeContext.ordinal).toBe(first.sourceOrdinal);
    const next = await ingest.accept("另一条", { kind: "text_part", entryId: "entry_2", contentSlot: 0, partIndex: 0 });
    expect(next.sourceOrdinal).toBe(2);
    expect(ingest.status()).toEqual({
      state: "receiving",
      objectCount: 2,
      lastOrdinal: 2,
      totalBytes: first.payloadBytes + next.payloadBytes,
    });
  });

  // 并发接收同一身份时，身份预占必须发生在暂存 await 之前：否则两个请求都通过去重检查，时间线出现重复。
  test("并发提交同一身份时恰好一个成功", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const meta: HistoryRecordMeta = { kind: "text_part", entryId: "entry_concurrent", contentSlot: 0, partIndex: 0 };

    const results = await Promise.allSettled([ingest.accept("并发一", meta), ingest.accept("并发二", meta)]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = rejected[0]?.reason;
    if (!(reason instanceof SyncProtocolError)) throw new Error("expected SyncProtocolError from the duplicate accept");
    expect(reason.code).toBe("DUPLICATE_OBJECT");
    // 被拒请求不得再消耗编号：目录仍从 1 起连续。
    expect(ingest.status()).toMatchObject({ objectCount: 1, lastOrdinal: 1 });
  });

  // 窗口敞着时第二次 begin 必须拒绝：两个 load 共用同一编号空间会让 ordinal 与字节流静默互相穿插。
  test("接收窗口未关闭时第二次 begin 被拒", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const busy = await captureIngestError(() =>
      ingest.begin({ scopeKey: SCOPE_KEY, generation: GENERATION, loadId: "load_ingest_0002" }),
    );
    expect(busy.code).toBe("SCOPE_BUSY");
    // 空 load 的边界是 0，冻结后可用新 loadId 开下一次尝试（重试语义），编号与计数整体归零。
    ingest.markReceivingComplete(0);
    await ingest.begin({ scopeKey: SCOPE_KEY, generation: "gen_ingest_0002", loadId: "load_ingest_0002" });
    expect(ingest.status()).toEqual({ state: "receiving", objectCount: 0, lastOrdinal: 0, totalBytes: 0 });
    expect((await ingest.accept({ text: "新代" }, { kind: "history_object", entryId: "entry_1" })).sourceOrdinal).toBe(
      1,
    );
  });
});

describe("有界校验", () => {
  // 结构炸弹必须在 JSON.parse 与落额度之前拒绝：深度上限是唯一能挡住深嵌套分配的入口。
  test("超深 JSON 被 scanJsonText 拒绝", async () => {
    const { ingest, admission } = await createHarness({ inputs: { jsonMaxDepth: 8 } });
    await begin(ingest);
    let deep: unknown = 0;
    for (let index = 0; index < 12; index += 1) {
      deep = [deep];
    }
    const error = await captureIngestError(() => ingest.accept(deep, { kind: "history_object", entryId: "entry_1" }));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(ingest.status()).toEqual({ state: "receiving", objectCount: 0, lastOrdinal: 0, totalBytes: 0 });
    expect(admission.used("frameParse")).toBe(0);
  });

  // 节点上限挡住「扁平但节点极多」的结构：字节上限单独挡不住这种炸弹，两种上限必须同时生效。
  test("超节点 JSON 被拒绝", async () => {
    const { ingest } = await createHarness({ inputs: { jsonMaxNodes: 4 } });
    await begin(ingest);
    const error = await captureIngestError(() =>
      ingest.accept([1, 2, 3, 4, 5, 6], { kind: "history_object", entryId: "entry_1" }),
    );
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(ingest.status().lastOrdinal).toBe(0);
  });

  // 记录头非法的提交不能占编号：错误输入若消耗 ordinal，后续对象的编号会与目录范围整体错位。
  test("非法记录头被拒且不消耗编号", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const invalidMetas = [
      runtimeMeta('{"kind":"unknown_kind"}'),
      runtimeMeta('{"kind":"history_object","entryId":""}'),
      runtimeMeta('{"kind":"text_part","entryId":"entry_1","partIndex":-1}'),
      runtimeMeta('{"kind":"text_part","entryId":"entry_1","contentSlot":1.5}'),
      runtimeMeta(JSON.stringify({ kind: "text_part", entryId: "e".repeat(257) })),
    ];
    for (const meta of invalidMetas) {
      const error = await captureIngestError(() => ingest.accept({ text: "x" }, meta));
      expect(["MALFORMED_FRAME", "IDENTIFIER_TOO_LONG"]).toContain(error.code);
    }
    expect(ingest.status().lastOrdinal).toBe(0);
    expect((await ingest.accept({ text: "x" }, { kind: "history_object", entryId: "entry_1" })).sourceOrdinal).toBe(1);
  });

  // 无法 JSON 表示的值没有合法保真字节：必须在写盘前失败，不能落一段空字节把「不可表示」伪装成「空内容」。
  test("不可序列化的值被拒", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const error = await captureIngestError(() =>
      ingest.accept({ count: 1n }, { kind: "history_object", entryId: "entry_1" }),
    );
    expect(error.code).toBe("MALFORMED_FRAME");
    expect(ingest.status().lastOrdinal).toBe(0);
  });
});

describe("大帧单任务路径", () => {
  // 大帧是进程级稀缺资源：并发第二个必须立刻被拒（不排队不等待），第一个的 frameParse 额度与单任务槽都要回收。
  test("并发第二个大帧被拒且额度正确释放", async () => {
    const { ingest, admission, profile } = await createHarness({ inputs: { largeFrameThresholdBytes: 64 } });
    await begin(ingest);
    const big = "x".repeat(200);
    const payloadBytes = fidelitySerialize(big).byteLength;
    expect(payloadBytes).toBeGreaterThan(64);
    const first = ingest.accept(big, { kind: "text_part", entryId: "entry_1", partIndex: 0 });
    const second = ingest.accept(big, { kind: "text_part", entryId: "entry_2", partIndex: 0 });
    expect(admission.used("frameParse")).toBe(payloadBytes);
    const error = await captureIngestError(() => second);
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect((await first).sourceOrdinal).toBe(1);
    expect(await ingest.readRecord(1)).toEqual(fidelitySerialize(big));
    expect(admission.used("frameParse")).toBe(0);
    expect(admission.available("frameParse")).toBe(profile.serverPools.frameParse);
    expect(ingest.status().lastOrdinal).toBe(1);
    // 单任务槽同样放行：第一个结束后到来的大帧正常接收
    const third = await ingest.accept(big, { kind: "text_part", entryId: "entry_3", partIndex: 0 });
    expect(third.sourceOrdinal).toBe(2);
    expect(admission.used("frameParse")).toBe(0);
  });

  // 小帧走常规入口、不占 frameParse 额度：否则常规吞吐要与大帧抢同一个池，大帧阈值会拖累普通对象。
  test("小帧不占 frameParse 额度且编号按调用顺序", async () => {
    const { ingest, admission } = await createHarness({ inputs: { largeFrameThresholdBytes: 64 } });
    await begin(ingest);
    const first = ingest.accept({ text: "小" }, { kind: "history_object", entryId: "entry_1" });
    const second = ingest.accept({ text: "小" }, { kind: "history_object", entryId: "entry_2" });
    expect(admission.used("frameParse")).toBe(0);
    const [a, b] = await Promise.all([first, second]);
    expect([a.sourceOrdinal, b.sourceOrdinal]).toEqual([1, 2]);
    expect(ingest.status().objectCount).toBe(2);
    // 并发提交的字节顺序必须与编号顺序一致
    expect(await ingest.readRecord(1)).toEqual(fidelitySerialize({ text: "小" }));
    expect(await ingest.readRecord(2)).toEqual(fidelitySerialize({ text: "小" }));
  });

  // 大帧必须计费：缺 admission 时宁可拒绝，也不能让无额度的大帧绕过 frameParse 池（§10.1 缺配置拒绝启用）。
  test("缺省 admission 时拒绝大帧", async () => {
    const { ingest } = await createHarness({ inputs: { largeFrameThresholdBytes: 64 }, admission: false });
    await begin(ingest);
    const error = await captureIngestError(() =>
      ingest.accept("x".repeat(200), { kind: "text_part", entryId: "entry_1", partIndex: 0 }),
    );
    expect(error.code).toBe("ADMISSION_REJECTED");
    expect(ingest.status().lastOrdinal).toBe(0);
    expect((await ingest.accept({ text: "小" }, { kind: "history_object", entryId: "entry_1" })).sourceOrdinal).toBe(1);
  });
});

describe("状态、暂存与配额", () => {
  // 三态与三个计数是构建阶段判断「收了多少、能否开建」的唯一依据，必须随窗口推进同步演化。
  test("status() 随窗口推进演化", async () => {
    const { ingest } = await createHarness();
    expect(ingest.status()).toEqual({ state: "idle", objectCount: 0, lastOrdinal: 0, totalBytes: 0 });
    await begin(ingest);
    expect(ingest.status()).toEqual({ state: "receiving", objectCount: 0, lastOrdinal: 0, totalBytes: 0 });
    const first = await ingest.accept({ text: "a" }, { kind: "history_object", entryId: "entry_1" });
    expect(ingest.status()).toEqual({
      state: "receiving",
      objectCount: 1,
      lastOrdinal: 1,
      totalBytes: first.payloadBytes,
    });
    const second = await ingest.accept({ text: "bb" }, { kind: "history_object", entryId: "entry_2" });
    expect(ingest.status()).toEqual({
      state: "receiving",
      objectCount: 2,
      lastOrdinal: 2,
      totalBytes: first.payloadBytes + second.payloadBytes,
    });
    ingest.markReceivingComplete(2);
    expect(ingest.status().state).toBe("receivingComplete");
  });

  // 保真往返：暂存字节要能按 ordinal 经 spool.readRange 精确取回并还原成等值对象，含多字节字符与孤立代理项。
  test("暂存字节可经 spool.readRange 读回并保真反序列化", async () => {
    const { ingest, spool } = await createHarness();
    await begin(ingest);
    const value = { text: "中文🙂\ud800 尾", nested: { ratio: 1.5, list: [true, null] } };
    const records = [
      await ingest.accept(value, { kind: "history_object", entryId: "entry_1" }),
      await ingest.accept("第二段", { kind: "history_object", entryId: "entry_2" }),
    ];
    ingest.markReceivingComplete(2);
    const manifest = await ingest.stagedManifest();
    if (manifest === null) {
      throw new Error("expected a staged manifest");
    }
    expect(manifest.sealed).toBe(true);
    expect(manifest.totalBytes).toBe(records[0].payloadBytes + records[1].payloadBytes);
    const firstRange = rangeOf(records, 1);
    const restored = fidelityDeserialize(await spool.readRange(manifest, firstRange.offset, firstRange.length));
    expect(restored).toEqual(value);
    // 孤立代理项按代码单元逐位相等：往返不接受任何替换或补齐
    expect((restored as { text: string }).text).toBe(value.text);
    const secondRange = rangeOf(records, 2);
    const secondBytes = await spool.readRange(manifest, secondRange.offset, secondRange.length);
    expect(fidelityDeserialize(secondBytes)).toBe("第二段");
    expect(records[1].digest).toBe(sha256Digest(secondBytes));
  });

  // readRecord 是块构建按编号读取的入口：编号到字节区间的映射必须与暂存流一致，缺口必须显式失败。
  test("readRecord 按编号定位且缺口报 IMPORT_INCOMPLETE", async () => {
    const { ingest } = await createHarness();
    await begin(ingest);
    const first = ingest.accept({ text: "一" }, { kind: "history_object", entryId: "entry_1" });
    const second = ingest.accept({ text: "二" }, { kind: "history_object", entryId: "entry_2" });
    await Promise.all([first, second]);
    expect(await ingest.readRecord(1)).toEqual(fidelitySerialize({ text: "一" }));
    expect(await ingest.readRecord(2)).toEqual(fidelitySerialize({ text: "二" }));
    const error = await captureIngestError(() => ingest.readRecord(3));
    expect(error.code).toBe("IMPORT_INCOMPLETE");
    expect(error.safeContext.ordinal).toBe(3);
  });

  // 配额超限是整批失败（暂存器已归还额度并抛弃任务）：接收器必须标记撕裂，避免带着编号空洞继续接收。
  test("暂存配额超限后归还额度并拒绝续收", async () => {
    const { ingest, spool } = await createHarness({
      spool: { segmentBytes: 128, taskQuotaBytes: 300, processQuotaBytes: 1024 },
    });
    await begin(ingest);
    const first = await ingest.accept({ text: "a" }, { kind: "history_object", entryId: "entry_1" });
    expect(first.payloadBytes).toBeLessThan(300);
    const error = await captureIngestError(() =>
      ingest.accept({ text: "b".repeat(400) }, { kind: "history_object", entryId: "entry_2" }),
    );
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(spool.stats().totalBytes).toBe(0);
    expect(spool.stats().taskBytes.size).toBe(0);
    // 洞是显式的：编号已推进到 2，对象数仍是 1
    expect(ingest.status()).toEqual({
      state: "receiving",
      objectCount: 1,
      lastOrdinal: 2,
      totalBytes: first.payloadBytes,
    });
    const later = await captureIngestError(() =>
      ingest.accept({ text: "c" }, { kind: "history_object", entryId: "entry_3" }),
    );
    expect(later.code).toBe("CAPACITY_EXCEEDED");
    const freeze = await captureIngestError(() => ingest.markReceivingComplete(2));
    expect(freeze.code).toBe("CAPACITY_EXCEEDED");
  });
});
