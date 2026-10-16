// packages/chat-channel/src/__tests__/sync-verify-history.test.ts
// 对抗式验证：历史导入管道（设计 §4.3 保真 JSON、§5.1 暂存配额、§5.2 块构建、§5.5 构建池、§5.6 提交器）。
//
// 与各模块自己的守护测试不同，本文件只攻击**静默失败路径**：丢内容、丢记录、泄漏额度或 Doc、
// 越限返回值、把未提交物说成已提交。断言全部落在可观察事实上（真实文件系统、真实 Yjs、真实
// MemoryProjectionStore），不使用模块替身；发现的可证伪断言以「缺陷复现（待修复）」标记，不放宽断言换绿。
//
// 已知偏差（仅作记录，见报告）：
// - 已释放的 `SpoolTask` 句柄仍报告释放前的 `bytesWritten`（`readRange` 会正确拒绝）。
// - `scanJsonText` 不校验上限字段本身：`NaN` 会让对应护栏静默失效（分片尺寸有校验，扫描上限没有）。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, FAIRNESS_CONFIG, SERVER_POOL_BYTES } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { type BlockRecordInput, type BuiltBlock, buildContentBlock } from "../sync/history/block-builder";
import { BlockBuildPool, type BuildPoolConfig, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { HistoryCommitter } from "../sync/history/committer";
import {
  fidelityDeserialize,
  fidelitySerialize,
  joinJsonParts,
  joinStringParts,
  scanJsonText,
  splitJsonParts,
  splitStringParts,
  summarizePayload,
} from "../sync/history/fidelity-json";
import { HistorySpool, type SpoolConfig } from "../sync/history/spool";
import { SyncProtocolError } from "../sync/protocol/errors";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { DocStateSnapshot } from "../sync/store/types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const FIXED_NOW = 1_700_000_000_000;
/** 时间源固定：租约、排队时长与诊断时间戳都必须可复现。 */
const fixedClock: Clock = { now: () => FIXED_NOW };

/** 本文件创建的临时根目录；用例结束整体删除，暂存残留不留进系统临时目录。 */
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 建独立临时根目录并返回其下尚未创建的暂存子目录（目录由暂存器按需创建）。 */
async function createBasePath(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return join(root, "spool");
}

/** 建一个暂存器实例；配额用小数值注入，避免真写 GiB 级数据。 */
async function createSpool(overrides: Partial<SpoolConfig> = {}): Promise<{ spool: HistorySpool; basePath: string }> {
  const basePath = await createBasePath("sync-verify-spool-");
  const config: SpoolConfig = {
    basePath,
    segmentBytes: 64,
    taskQuotaBytes: 256,
    processQuotaBytes: 512,
    ...overrides,
  };
  return { spool: new HistorySpool(config, fixedClock), basePath };
}

/** 捕获协议错误：非本层异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
async function captureError(run: () => unknown): Promise<SyncProtocolError> {
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

/** 同步捕获：用于断言「提交期拒绝是同步抛出，而不是返回一个 rejected Promise」。 */
function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown synchronously");
}

/** 逐字节比较视图：`toEqual` 会给出行内差异，比布尔比较更易定位错位位置。 */
function bytesOf(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

/** 字节模式：每个字节由全局偏移推导，跨段顺序一旦错位，比对立即暴露。 */
function patternBytes(offset: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (offset + index) % 251);
}

/** 子串出现次数：重复内容「逐份保留」断言的可读辅助。 */
function countOccurrences(haystack: Uint8Array, needle: Uint8Array): number {
  let hits = 0;
  outer: for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    hits += 1;
  }
  return hits;
}

/** 手动驱动的任务体：并发上限与排队行为只有在任务可被外部挂起时才可断言。 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出事件循环：等微任务与已排定的宏任务跑完。 */
async function settleEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 单任务字节数：额度断言用整数份数与它对账。 */
const TASK_BYTES = 1024;

/** 测试池：注入固定时钟与真实 AdmissionController，池额度远小于默认值以便逐份核对。 */
function createPool(config: BuildPoolConfig): { pool: BlockBuildPool; admission: AdmissionController } {
  const admission = new AdmissionController({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...SERVER_POOL_BYTES, historyBuild: 64 * TASK_BYTES },
  });
  return { pool: new BlockBuildPool(config, admission, fixedClock), admission };
}

/** 构造一条块记录：载荷按序号可预测，跨块拼接错位即可见。 */
function record(sourceOrdinal: number, payloadBytes: number, fill?: Uint8Array): BlockRecordInput {
  return {
    sourceOrdinal,
    kind: "history_object",
    payload: fill ?? patternBytes(sourceOrdinal * 7, payloadBytes),
    entryId: `entry_${sourceOrdinal}`,
    entryOrder: sourceOrdinal,
    contentSlot: 0,
    partIndex: 0,
  };
}

/** 以巨大硬限构建（永不触发重新分块），用于测量某个前缀的 canonical 字节数。 */
function measurePrefixBytes(records: readonly BlockRecordInput[], count: number, generation: string): number {
  return buildContentBlock({
    generation,
    blockIndex: 0,
    records: records.slice(0, count),
    targetPayloadBytes: 1 << 24,
    hardLimitBytes: 1 << 24,
    rand: deterministicRandomSource(`measure-${count}`),
    digest: sha256Digest,
  }).snapshot.byteLength;
}

/**
 * 在 Y.Doc 原型上打桩统计「构造 → 销毁」配对：只在本用例的同步窗口内生效并立即复位，
 * 不改变任何模块导出。`getMap` 被构建函数每个 Doc 调用一次，是「本次构建创建了几个 Doc」的可靠代理。
 */
function installDocSpy(): { created: number; destroyed: Y.Doc[]; restore(): void } {
  const originalGetMap = Y.Doc.prototype.getMap;
  const originalDestroy = Y.Doc.prototype.destroy;
  const spy = {
    created: 0,
    destroyed: [] as Y.Doc[],
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
    spy.destroyed.push(this);
    originalDestroy.call(this);
  };
  return spy;
}
const SCAN_LIMITS = { maxBytes: 1 << 20, maxDepth: 64, maxNodes: 1 << 20 } as const;

describe("保真 JSON 层（设计 §4.3）", () => {
  // 孤立代理项、CRLF、控制字符与组合序列往返必须逐代码单元相等：任何替换或补齐都是内容篡改。
  test("孤立代理项、CRLF 与控制字符往返逐代码单元相等", () => {
    const samples = [
      "\ud800",
      "\udc00",
      "\ud800\ud800",
      "a\r\nb",
      "\u0000",
      "\u2028\u2029",
      "👨👩👧",
      "e\u0301",
      "中文\r\n末尾",
      "",
    ];
    for (const sample of samples) {
      const back = fidelityDeserialize(fidelitySerialize(sample)) as string;
      expect({ sample, length: back.length }).toEqual({ sample, length: sample.length });
      expect({ sample, bytes: bytesOf(textEncoder.encode(back)) }).toEqual({
        sample,
        bytes: bytesOf(textEncoder.encode(sample)),
      });
    }
  });

  // 扫描的字节口径必须是 UTF-8：按 UTF-16 代码单元计数会把 4 字节字符算成 1，静默放行超限载荷。
  test("扫描字节口径是 UTF-8 而非 UTF-16 代码单元", () => {
    const text = '"😀"';
    expect(text.length).toBe(4);
    expect(scanJsonText(text, { maxBytes: 6, maxDepth: 4, maxNodes: 4 }).bytes).toBe(6);
    const over = captureSyncError(() => scanJsonText(text, { maxBytes: 5, maxDepth: 4, maxNodes: 4 }));
    expect(over.code).toBe("CAPACITY_EXCEEDED");
  });

  // 非有限数字字面量必须整例拒绝：`JSON.stringify(Infinity)` 写成 null，静默变成 null 等于篡改内容。
  test("非有限数字字面量一律拒绝，不得静默变成 null 或 Infinity", () => {
    const literals = ["1e999", "-1e999", "1e309", "9".repeat(400), "[-1e999]", '{"a":1e999}', "NaN", "Infinity"];
    const observed = literals.map((literal) => {
      const failure = captureSyncError(() => scanJsonText(literal, SCAN_LIMITS));
      return { literal, code: failure.code };
    });
    expect(observed.filter((item) => item.code !== "MALFORMED_FRAME")).toEqual([]);
  });

  // 接受域必须与 JSON.parse 逐例一致（非有限数字是规格明示的例外，已由上一用例单独覆盖）。
  test("扫描接受域与 JSON.parse 逐例一致，且接受项的字节数等于 UTF-8 长度", () => {
    const cases = [
      "1",
      "-1",
      "-0",
      "1.5",
      "1e5",
      "1E+5",
      "1e-5",
      "1e308",
      "1e-999",
      "true",
      "false",
      "null",
      '""',
      '"a"',
      '"\\u0041"',
      '"\\ud800"',
      '"\\ud83d\\ude00"',
      '"\ud800"',
      '"\u007f"',
      "{}",
      "[]",
      "[1,2]",
      '{"a":1}',
      '{"a":1,"a":2}',
      "  [1]  ",
      "\t[1]\n",
      "[[]]",
      '{"":0}',
      "01",
      "+1",
      ".5",
      "5.",
      "0x10",
      "True",
      "NULL",
      "nulll",
      "truex",
      '"a"x',
      '"\\u12"',
      '"\\uZZZZ"',
      '"\\x41"',
      '"\\0"',
      '"\\a"',
      '"\u0001"',
      "[1,]",
      "{a:1}",
      "{'a':1}",
      '{"a" 1}',
      "[1 2]",
      "{,}",
      "[1] [2]",
      "[1]x",
      "",
      " ",
      "\u00a0[]",
      "\u000b[]",
      "\ufeff[]",
    ];
    const observed = cases.map((literal) => {
      let parseAccepts = true;
      try {
        JSON.parse(literal);
      } catch {
        parseAccepts = false;
      }
      let scanAccepts = true;
      let bytes = 0;
      try {
        bytes = scanJsonText(literal, SCAN_LIMITS).bytes;
      } catch {
        scanAccepts = false;
      }
      return { literal, scanAccepts, parseAccepts, bytes, utf8Bytes: textEncoder.encode(literal).byteLength };
    });
    // 两个方向都要暴露：扫描多接受（吃下非法输入）与少接受（把合法输入判成非法）都是契约漂移。
    expect(observed.filter((item) => item.scanAccepts !== item.parseAccepts).map((item) => item.literal)).toEqual([]);
    expect(
      observed.filter((item) => item.scanAccepts).map((item) => [item.literal, item.bytes, item.utf8Bytes]),
    ).toEqual(
      observed.filter((item) => item.scanAccepts).map((item) => [item.literal, item.utf8Bytes, item.utf8Bytes]),
    );
    // 防空转：两侧都真的要有样本。
    const accepted = observed.filter((item) => item.scanAccepts).length;
    expect(accepted).toBeGreaterThan(25);
    expect(accepted).toBeLessThan(cases.length);
  });

  // 上限判定必须落在边界上（恰好等于上限接受、少 1 拒绝），且超深输入不得退化成 RangeError。
  test("深度/节点/字节上限在边界处生效，超深输入不得抛 RangeError", () => {
    expect(scanJsonText("[[1]]", { ...SCAN_LIMITS, maxDepth: 2 }).depth).toBe(2);
    expect(captureSyncError(() => scanJsonText("[[1]]", { ...SCAN_LIMITS, maxDepth: 1 })).code).toBe(
      "CAPACITY_EXCEEDED",
    );
    expect(scanJsonText("[1,2,3]", { ...SCAN_LIMITS, maxNodes: 4 }).nodes).toBe(4);
    expect(captureSyncError(() => scanJsonText("[1,2,3]", { ...SCAN_LIMITS, maxNodes: 3 })).code).toBe(
      "CAPACITY_EXCEEDED",
    );
    expect(scanJsonText("[1,2,3]", { ...SCAN_LIMITS, maxBytes: 7 }).bytes).toBe(7);
    expect(captureSyncError(() => scanJsonText("[1,2,3]", { ...SCAN_LIMITS, maxBytes: 6 })).code).toBe(
      "CAPACITY_EXCEEDED",
    );
    // 递归下降的栈上限必须由扫描器自己截断：露出 RangeError 就等于未分类异常穿过协议边界。
    const nesting = "[".repeat(20_000);
    const deep = `${nesting}1${"]".repeat(20_000)}`;
    const failure = captureSyncError(() =>
      scanJsonText(deep, { maxBytes: SCAN_LIMITS.maxBytes, maxDepth: 4096, maxNodes: SCAN_LIMITS.maxNodes }),
    );
    expect(failure.code).toBe("CAPACITY_EXCEEDED");
  });

  // 空载荷：JSON 侧必须至少一片（分片是摘要的唯一载体），文本侧口径不同须显式记录。
  test("空载荷产出一片零长度分片，空文本产出零片（口径不对称）", () => {
    const parts = splitJsonParts(new Uint8Array(0), 16);
    expect(parts.length).toBe(1);
    expect([parts[0].byteStart, parts[0].byteEnd]).toEqual([0, 0]);
    expect(joinJsonParts(parts).byteLength).toBe(0);
    expect(summarizePayload(new Uint8Array(0)).partCount).toBe(1);
    // 缺口记录：空串得到 0 片，下游无法据此区分「空内容」与「分片缺失」（报告 §2）。
    expect(splitStringParts("", 16)).toEqual([]);
    expect(joinStringParts([])).toBe("");
  });

  // 重复内容不得被折叠：相同字节出现在多处时每一份都要独立保留（去重只能由上层按记录身份做）。
  test("重复内容逐份保留，不得被折叠或去重", () => {
    const payload = textEncoder.encode('["dup","dup","dup"]');
    const pieces = splitJsonParts(payload, 4);
    expect(pieces.length).toBe(Math.ceil(payload.byteLength / 4));
    const joined = joinJsonParts(pieces);
    expect(bytesOf(joined)).toEqual(bytesOf(payload));
    expect(countOccurrences(joined, textEncoder.encode("dup"))).toBe(3);
    // 同内容摘要必然相同：这正是「不能用摘要做去重键」的证据，而不是可折叠的理由。
    expect(summarizePayload(textEncoder.encode('["dup","dup","dup"]')).digest).toBe(summarizePayload(payload).digest);
  });

  // 代理对跨字节分片：切在 UTF-8 序列中间时重组必须逐字节相等，解码后不得出现替换字符。
  test("代理对被按字节切断后重组逐字节相等且解码无替换", () => {
    const text = "😀x";
    const payload = textEncoder.encode(text);
    const observed = [1, 2, 3, 4, 5].map((maxPartBytes) => {
      const joined = joinJsonParts(splitJsonParts(payload, maxPartBytes));
      return { maxPartBytes, bytes: bytesOf(joined), decoded: textDecoder.decode(joined) };
    });
    expect(observed.map((item) => item.bytes)).toEqual(observed.map(() => bytesOf(payload)));
    expect(observed.map((item) => item.decoded)).toEqual(observed.map(() => text));
    expect(observed.filter((item) => item.decoded.includes("\ufffd"))).toEqual([]);
  });

  // 分片自证：partCount 不一致、索引跳号、摘要不符都不得被当作「完整载荷」接受。
  test("分片自证失败时不得被当作完整载荷", () => {
    const payload = textEncoder.encode('"abcdefgh"');
    const parts = splitJsonParts(payload, 4);
    expect(parts.length).toBe(3);
    const disagreeing = [parts[0], { ...parts[1], partCount: 5 }, parts[2]];
    expect(captureSyncError(() => joinJsonParts(disagreeing)).code).toBe("IMPORT_INCOMPLETE");
    const skipped = [parts[0], parts[1], { ...parts[2], partIndex: 3 }];
    expect(captureSyncError(() => joinJsonParts(skipped)).code).toBe("IMPORT_INCOMPLETE");
    const foreignDigest = [parts[0], parts[1], { ...parts[2], digest: sha256Digest(textEncoder.encode("other")) }];
    expect(captureSyncError(() => joinJsonParts(foreignDigest)).code).toBe("DIGEST_CONFLICT");
  });

  // 坏字节必须可见：严格解码的失败不得被 U+FFFD 替换掩盖（否则「字节损坏」会变成「内容变了」）。
  test("非法或截断的 UTF-8 报错而不是静默替换成 U+FFFD", () => {
    expect(captureSyncError(() => fidelityDeserialize(new Uint8Array([0x22, 0xff, 0x22]))).code).toBe(
      "MALFORMED_FRAME",
    );
    expect(captureSyncError(() => fidelityDeserialize(textEncoder.encode('"😀"').slice(0, 5))).code).toBe(
      "MALFORMED_FRAME",
    );
  });

  // 已知缺口：`scanJsonText` 不校验上限字段，NaN 会静默关闭护栏（分片尺寸有校验，扫描上限没有）。
  test("NaN 上限静默关闭扫描护栏（缺口记录：上限字段未做校验）", () => {
    const payload = `[${Array.from({ length: 500 }, () => "1").join(",")}]`;
    const observed = scanJsonText(payload, { maxBytes: Number.NaN, maxDepth: Number.NaN, maxNodes: Number.NaN });
    expect(observed.bytes).toBeGreaterThan(1000);
    expect(observed.nodes).toBeGreaterThan(500);
    // 对照：分片尺寸走的是显式校验，非法值报 ADMISSION_REJECTED 而不是静默放开。
    expect(captureSyncError(() => splitJsonParts(new Uint8Array(4), 0)).code).toBe("ADMISSION_REJECTED");
  });
});
describe("历史暂存配额（设计 §5.1）", () => {
  // 并发追加必须串行落盘：调用顺序即字节顺序，任何交错都会让 readRange 的拼接结果错位。
  test("并发追加串行落盘，跨段读取与调用顺序逐字节一致", async () => {
    const { spool } = await createSpool();
    const task = await spool.beginTask("load_serial");
    const appends = Array.from({ length: 6 }, (_, index) => patternBytes(index * 40, 40));
    await Promise.all(appends.map((bytes) => task.append(bytes)));
    const manifest = await task.seal();
    expect(manifest.totalBytes).toBe(240);
    expect(manifest.segments.map((segment) => segment.bytes)).toEqual([64, 64, 64, 48]);
    const read = await spool.readRange(manifest, 0, 240);
    expect(bytesOf(read)).toEqual(bytesOf(patternBytes(0, 240)));
    expect(spool.stats()).toEqual({ taskBytes: new Map([["load_serial", 240]]), totalBytes: 240 });
  });

  // 并发追加越界时必须整体回收：不得留下半个任务占额度，也不得留下半个任务的段文件。
  test("并发追加越界后账目归零、目录清空、任务出册", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("load_over");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) => task.append(patternBytes(index * 40, 40))),
    );
    const codes = results.map((result) =>
      result.status === "fulfilled" ? "ok" : (result.reason as SyncProtocolError).code,
    );
    // 任务配额 256：前 6 次（240 字节）成功，第 7 次越界并整体作废，第 8 次看到已释放的任务。
    expect(codes).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "CAPACITY_EXCEEDED", "RESOURCE_RETIRED"]);
    expect(spool.stats()).toEqual({ taskBytes: new Map(), totalBytes: 0 });
    expect(await readdir(basePath)).toEqual([]);
    expect((await captureError(() => task.append(patternBytes(0, 8)))).code).toBe("RESOURCE_RETIRED");
    expect((await captureError(() => spool.readRange(task.manifest, 0, 8))).code).toBe("RESOURCE_RETIRED");
    // 任务已出册且目录已删：同 loadId 可以重新开始（重试换 loadId 是调用方义务，不该被残留目录阻塞）。
    const restarted = await spool.beginTask("load_over");
    expect(restarted.bytesWritten).toBe(0);
  });

  // 跨任务配额拒绝只回收被拒任务的段与额度：误伤在册任务等于让并发导入互相拆台。
  test("跨任务配额拒绝不得误删在册任务的段或额度", async () => {
    const { spool, basePath } = await createSpool({ taskQuotaBytes: 512, processQuotaBytes: 512 });
    const held = await spool.beginTask("load_held");
    await held.append(patternBytes(0, 300));
    const rejected = await spool.beginTask("load_rejected");
    expect((await captureError(() => rejected.append(patternBytes(0, 250)))).code).toBe("CAPACITY_EXCEEDED");
    expect(spool.stats()).toEqual({ taskBytes: new Map([["load_held", 300]]), totalBytes: 300 });
    expect(await readdir(basePath)).toEqual(["load_held"]);
    expect(bytesOf(await spool.readRange(held.manifest, 0, 300))).toEqual(bytesOf(patternBytes(0, 300)));
  });

  // 归还后的可用额度必须完整：漏还或多算都会让后续任务拿到「看不见的天花板」，且无法自愈。
  test("释放后的可用额度完整，拒绝不改变其它任务的计提", async () => {
    const { spool } = await createSpool({ taskQuotaBytes: 512, processQuotaBytes: 512 });
    const first = await spool.beginTask("load_first");
    await first.append(patternBytes(0, 300));
    const second = await spool.beginTask("load_second");
    await second.append(patternBytes(0, 200));
    const third = await spool.beginTask("load_third");
    expect((await captureError(() => third.append(patternBytes(0, 50)))).code).toBe("CAPACITY_EXCEEDED");
    expect(spool.stats().totalBytes).toBe(500);
    await spool.completeTask("load_first");
    await spool.completeTask("load_second");
    expect(spool.stats()).toEqual({ taskBytes: new Map(), totalBytes: 0 });
    // 进程配额 512：只有「账目彻底归零」时新任务才能一次拿满，任何泄漏都会让这里失败。
    const fourth = await spool.beginTask("load_fourth");
    await fourth.append(patternBytes(0, 512));
    expect(fourth.manifest.totalBytes).toBe(512);
    expect(spool.stats().totalBytes).toBe(512);
  });

  // 回归：曾因 failTask 先写诊断再归还配额，段目录被外部清理时抛错并永久占住配额（本次修复）。
  test("failTask 在段目录缺失时仍须归还配额", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("load_vanished");
    await task.append(patternBytes(0, 200));
    expect(spool.stats().totalBytes).toBe(200);
    // 模拟外部清理（另一实例的 cleanupOrphans / 运维）：任务仍在册，但段目录已消失。
    await rm(join(basePath, "load_vanished"), { recursive: true, force: true });
    expect((await captureError(() => spool.failTask("load_vanished", "probe"))).code).toBe("STAGING_FAILED");
    expect((await captureError(() => spool.failTask("load_vanished", "probe-retry"))).code).toBe("STAGING_FAILED");
    // 回归：段目录缺失不是「配额不归还」的理由（本次修复）——失败路径必须释放配额（设计 §5.1 配额回收 / §5.7 不变式 8）。
    expect(spool.stats().totalBytes).toBe(0);
  });

  // 释放后句柄不得再宣称字节可读：读回已删段会得到半截内容，必须报 RESOURCE_RETIRED 而不是短读。
  test("completeTask 后句柄读取必须被拒", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("load_released");
    await task.append(patternBytes(0, 120));
    await spool.completeTask("load_released");
    expect((await captureError(() => spool.readRange(task.manifest, 0, 120))).code).toBe("RESOURCE_RETIRED");
    expect(await readdir(basePath)).toEqual([]);
    // 已知偏差：句柄仍报告释放前的字节数（报告 §2），此处只固化「读取必须被拒」这条安全边界。
    expect(task.bytesWritten).toBe(120);
  });
});

describe("内容块构建（设计 §5.2）", () => {
  // 硬限下的重新分块必须只按记录边界切：逐轮重建要恰好覆盖每个序号一次，且每块都不得超限。
  test("超硬限重新分块不丢记录且每块 snapshot 不超限", () => {
    const generation = "gen_loop";
    const records = Array.from({ length: 12 }, (_, index) => record(index + 1, 40));
    // 硬限取「3 条记录的编码长度」：既保证单条能装下，又必然触发重新分块。
    const hardLimit = measurePrefixBytes(records, 3, generation);
    const covered: number[] = [];
    let remaining: readonly BlockRecordInput[] = records;
    let blockIndex = 0;
    while (remaining.length > 0) {
      const built = buildContentBlock({
        generation,
        blockIndex,
        records: remaining,
        targetPayloadBytes: hardLimit,
        hardLimitBytes: hardLimit,
        rand: deterministicRandomSource(`loop-${blockIndex}`),
        digest: sha256Digest,
      });
      expect(built.snapshot.byteLength).toBeLessThanOrEqual(hardLimit);
      expect(built.ordinalStart).toBe(remaining[0].sourceOrdinal);
      expect(built.recordCount).toBe(built.records.length);
      expect(built.ordinalEnd).toBe(built.records[built.records.length - 1].ordinal);
      covered.push(...built.records.map((entry) => entry.ordinal));
      remaining = remaining.slice(built.recordCount);
      blockIndex += 1;
      // 收敛保护：recordCount 为 0 会让上面的循环永远不结束。
      expect(blockIndex).toBeLessThanOrEqual(records.length + 1);
    }
    expect(covered).toEqual(records.map((entry) => entry.sourceOrdinal));
  });

  // 硬限小到单条都装不进时抛错——抛错路径同样不得泄漏构建期 Doc（每块一个 Doc，泄漏会随导入累积）。
  test("单条记录超硬限的抛错路径也必须销毁构建期 Doc", () => {
    const spy = installDocSpy();
    let failure: SyncProtocolError;
    try {
      failure = captureSyncError(() =>
        buildContentBlock({
          generation: "gen_destroy",
          blockIndex: 0,
          records: [record(1, 4096)],
          targetPayloadBytes: 64,
          hardLimitBytes: 64,
          rand: deterministicRandomSource("destroy"),
          digest: sha256Digest,
        }),
      );
    } finally {
      spy.restore();
    }
    expect(failure.code).toBe("CAPACITY_EXCEEDED");
    expect(spy.created).toBeGreaterThan(0);
    expect(spy.destroyed.length).toBe(spy.created);
    expect(spy.destroyed.every((doc) => doc.isDestroyed)).toBe(true);
  });

  // 结构性拒绝必须发生在建 Doc 之前：先构造再校验会让每次非法调用都留下一个活着的临时 Doc。
  test("参数与结构非法时在建 Doc 之前拒绝", () => {
    const spy = installDocSpy();
    try {
      const nonContiguous = captureSyncError(() =>
        buildContentBlock({
          generation: "gen_reject",
          blockIndex: 0,
          records: [record(2, 8), record(1, 8)],
          targetPayloadBytes: 1 << 16,
          hardLimitBytes: 1 << 16,
          rand: deterministicRandomSource("reject"),
          digest: sha256Digest,
        }),
      );
      expect(nonContiguous.code).toBe("MALFORMED_FRAME");
      const badLimits = captureSyncError(() =>
        buildContentBlock({
          generation: "gen_reject",
          blockIndex: 0,
          records: [record(1, 8)],
          targetPayloadBytes: 128,
          hardLimitBytes: 64,
          rand: deterministicRandomSource("reject-limits"),
          digest: sha256Digest,
        }),
      );
      expect(badLimits.code).toBe("ADMISSION_REJECTED");
    } finally {
      spy.restore();
    }
    expect(spy.created).toBe(0);
    expect(spy.destroyed.length).toBe(0);
  });
});
describe("构建池（设计 §5.5）", () => {
  // 并发上限与任务总量上限是池存在的理由：任何时刻在飞不得超 worker 数，在飞 + 排队不得超 tasksMax。
  test("乱序结算下并发水位不超 maxConcurrent，在飞与排队总数不超 tasksMax", async () => {
    const { pool } = createPool({ maxConcurrent: 2, maxQueued: 3, tasksMax: 5 });
    const gates = Array.from({ length: 5 }, () => createDeferred<void>());
    let live = 0;
    let watermark = 0;
    const observedTotals: number[] = [];
    const submitted = gates.map((gate) =>
      pool.submit({
        estimateBytes: TASK_BYTES,
        run: () => {
          live += 1;
          watermark = Math.max(watermark, live);
          const snapshot = pool.stats();
          observedTotals.push(snapshot.running + snapshot.queued);
          return gate.promise.then(() => {
            live -= 1;
          });
        },
      }),
    );
    expect(pool.stats()).toEqual({ running: 2, queued: 3, completed: 0, failed: 0 });
    // 乱序结算：队尾先完成，仍不得让第 3 个任务抢跑到前 2 个结算之前。
    for (const index of [3, 0, 4, 1, 2]) {
      gates[index].resolve();
      await settleEventLoop();
    }
    await Promise.all(submitted);
    expect(watermark).toBe(2);
    expect(observedTotals.filter((total) => total > 5)).toEqual([]);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 5, failed: 0 });
  });

  // 队列满是同步拒绝：不得返回一个 rejected Promise（那会变成 20,000 个放弃的 Promise），也不得占额度。
  test("队列满同步拒绝，不留额度与失败计数", async () => {
    const { pool, admission } = createPool({ maxConcurrent: 1, maxQueued: 2, tasksMax: 3 });
    const gates = Array.from({ length: 3 }, () => createDeferred<void>());
    const submitted = gates.map((gate) => pool.submit({ estimateBytes: TASK_BYTES, run: () => gate.promise }));
    expect(pool.stats()).toEqual({ running: 1, queued: 2, completed: 0, failed: 0 });
    const usedBefore = admission.used("historyBuild");
    const failure = captureSyncError(() => pool.submit({ estimateBytes: TASK_BYTES, run: async () => "never" }));
    expect(failure.code).toBe("CAPACITY_EXCEEDED");
    expect(admission.used("historyBuild")).toBe(usedBefore);
    // 提交期被拒的任务没有进入池，因此不得计入「已接纳任务的失败」。
    const after = pool.stats();
    expect([after.queued, after.failed, after.completed]).toEqual([2, 0, 0]);
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(submitted);
    expect(admission.used("historyBuild")).toBe(0);
  });

  // 任务抛错时额度必须归还、drain 必须完成、池必须继续可用：三条同时失败就是「一次失败拖垮导入」。
  test("任务抛错后额度归零、drain 完成且池继续可用", async () => {
    const { pool, admission } = createPool({ maxConcurrent: 2, maxQueued: 1, tasksMax: 3 });
    const gates = [createDeferred<void>(), createDeferred<void>()];
    const submitted = gates.map((gate) => pool.submit({ estimateBytes: TASK_BYTES, run: () => gate.promise }));
    expect(admission.used("historyBuild")).toBe(2 * TASK_BYTES);
    const drained = pool.drain();
    gates[0].reject(new Error("build failed"));
    gates[1].reject(new Error("build failed"));
    await drained;
    const settled = await Promise.allSettled(submitted);
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(admission.used("historyBuild")).toBe(0);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, completed: 0, failed: 2 });
    // 失败不得消耗池容量：紧接着的任务必须能立刻拿到槽位与额度。
    expect(await pool.submit({ estimateBytes: TASK_BYTES, run: async () => "ok" })).toBe("ok");
    expect(pool.stats().completed).toBe(1);
  });

  // maxQueued=0（不排队）与派生配置不自洽都必须在「进池之前」拒绝，而不是退化成无界排队或负队列。
  test("maxQueued=0 时并发满即拒，派生配置不自洽时在派生期拒绝", async () => {
    const { pool } = createPool({ maxConcurrent: 1, maxQueued: 0, tasksMax: 1 });
    const gate = createDeferred<void>();
    const running = pool.submit({ estimateBytes: TASK_BYTES, run: () => gate.promise });
    expect(captureSyncError(() => pool.submit({ estimateBytes: TASK_BYTES, run: async () => "never" })).code).toBe(
      "CAPACITY_EXCEEDED",
    );
    gate.resolve();
    await running;
    const broken = captureSyncError(() =>
      deriveBuildPoolConfig({ ...FAIRNESS_CONFIG, historyBuilderWorkers: 3, builderTasksMax: 2 }),
    );
    expect(broken.code).toBe("ADMISSION_REJECTED");
  });
});

const COMMIT_SCOPE = "org_verify/rcs_verify";
const COMMIT_GENERATION = "gen_verify_commit";

/** 提交器上下文：真实 MemoryProjectionStore + 已登记 staging 代次 + 同 scope 的 writer 租约。 */
async function createCommitContext(): Promise<{
  store: MemoryProjectionStore;
  committer: HistoryCommitter;
  epoch: number;
}> {
  const store = new MemoryProjectionStore({
    clock: fixedClock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 1000, retireGraceMs: 1000 },
  });
  const lease = await store.acquireWriter(COMMIT_SCOPE, "owner_verify", 60_000);
  await store.createGeneration({
    scopeKey: COMMIT_SCOPE,
    epoch: lease.epoch,
    generation: {
      scopeKey: COMMIT_SCOPE,
      generation: COMMIT_GENERATION,
      acpSessionId: "ses_verify",
      loadId: "load_verify",
      state: "staging",
      importEndOrdinal: null,
      entryRefs: {
        controlDocId: "doc_control",
        directoryDocId: "doc_directory",
        runtimeDocId: "doc_runtime",
        contentDocIds: [],
      },
      createdAt: FIXED_NOW,
    },
  });
  const committer = new HistoryCommitter({
    store,
    scopeKey: COMMIT_SCOPE,
    generation: COMMIT_GENERATION,
    lease,
    digest: sha256Digest,
  });
  return { store, committer, epoch: lease.epoch };
}

/** 构建一个内容块：软水位足够大，避免用例关心分块策略。 */
function buildBlock(blockIndex: number, records: readonly BlockRecordInput[]): BuiltBlock {
  return buildContentBlock({
    generation: COMMIT_GENERATION,
    blockIndex,
    records,
    targetPayloadBytes: 1 << 16,
    hardLimitBytes: 1 << 16,
    rand: deterministicRandomSource(`commit-${blockIndex}`),
    digest: sha256Digest,
  });
}

/** 读回既有块必须存在：把「读不到」与「字节不符」区分成两种失败。 */
function requireState(state: DocStateSnapshot | null): DocStateSnapshot {
  if (state === null) {
    throw new Error("expected a committed doc state");
  }
  return state;
}

describe("提交器（设计 §5.6）", () => {
  // 冲突重建物不得覆盖已提交 canonical 字节：字节、摘要与目录范围都必须仍是既有块的。
  test("冲突重建不得覆盖已提交 canonical 字节", async () => {
    const { store, committer } = await createCommitContext();
    const original = buildBlock(0, [
      record(1, 24, textEncoder.encode("original-one-00000001")),
      record(2, 24, textEncoder.encode("original-two-00000002")),
    ]);
    expect((await committer.commitBlock(original)).outcome).toBe("committed");
    const marker = textEncoder.encode("REBUILD-MARKER-0123456789");
    const rebuild = buildBlock(
      0,
      Array.from({ length: 5 }, (_, index) => record(index + 1, marker.byteLength, marker)),
    );
    // 正对照：标记确实进入了重建物字节，否则下面的「不出现」不构成证据。
    expect(countOccurrences(rebuild.snapshot, marker)).toBeGreaterThan(0);
    const conflict = await committer.commitBlock({ ...rebuild, docId: original.docId });
    expect(conflict.outcome).toBe("conflict");
    expect([conflict.ref.ordinalStart, conflict.ref.ordinalEnd, conflict.ref.hash]).toEqual([
      original.ordinalStart,
      original.ordinalEnd,
      original.hash,
    ]);
    const stored = requireState(await store.readDocStateAt(original.docId, 0));
    expect(bytesOf(stored.snapshot)).toEqual(bytesOf(original.snapshot));
    expect(countOccurrences(stored.snapshot, marker)).toBe(0);
    const directory = await committer.listDirectory(10);
    expect(directory.blocks.map((entry) => [entry.ordinalStart, entry.ordinalEnd, entry.hash])).toEqual([
      [original.ordinalStart, original.ordinalEnd, original.hash],
    ]);
  });

  // 目录只能列已提交块：仅构建过的块与「已登记未封口」的块都不得出现在目录里。
  test("目录只列已提交块，未封口与未提交的块都不出现", async () => {
    const { store, committer, epoch } = await createCommitContext();
    const built = buildBlock(0, [record(1, 32)]);
    // 仅构建、未提交：存储里不得有任何痕迹。
    expect((await committer.listDirectory(10)).blocks).toEqual([]);
    expect(await store.readDocStateAt(built.docId, 0)).toBeNull();
    // 已登记但未封口：字节已在存储里，仍不得进入可用目录。
    const registered = await store.createDoc({
      scopeKey: COMMIT_SCOPE,
      epoch,
      doc: {
        scopeKey: COMMIT_SCOPE,
        generation: COMMIT_GENERATION,
        docId: built.docId,
        kind: "content",
        state: "active",
        snapshot: built.snapshot,
        hash: built.hash,
        baseSeq: 0,
        finalSeq: null,
        blockIndex: 0,
        ordinalStart: 900,
        ordinalEnd: 905,
        dependsOn: [],
      },
    });
    expect(registered.outcome).toBe("committed");
    expect(requireState(await store.readDocStateAt(built.docId, 0)).snapshot.byteLength).toBeGreaterThan(0);
    expect((await committer.listDirectory(10)).blocks).toEqual([]);
    // 另一个 docId 提交成功后才出现在目录里：目录不是「存储里有什么」而是「已提交了什么」。
    const committed = buildBlock(1, [record(6, 32)]);
    expect((await committer.commitBlock(committed)).outcome).toBe("committed");
    expect((await committer.listDirectory(10)).blocks.map((entry) => entry.ordinalStart)).toEqual([6]);
  });

  // 同 docId 同摘要但尚未封口时不得当作已提交：字节存在不等于可读，目录里没有就必须报未完成。
  test("同 docId 同摘要但未封口时报 IMPORT_INCOMPLETE 而不是假装成功", async () => {
    const { store, committer, epoch } = await createCommitContext();
    const built = buildBlock(0, [record(1, 16)]);
    await store.createDoc({
      scopeKey: COMMIT_SCOPE,
      epoch,
      doc: {
        scopeKey: COMMIT_SCOPE,
        generation: COMMIT_GENERATION,
        docId: built.docId,
        kind: "content",
        state: "active",
        snapshot: built.snapshot,
        hash: built.hash,
        baseSeq: 0,
        finalSeq: null,
        blockIndex: 0,
        ordinalStart: 1,
        ordinalEnd: 1,
        dependsOn: [],
      },
    });
    const failure = await captureError(() => committer.commitBlock(built));
    expect(failure.code).toBe("IMPORT_INCOMPLETE");
    expect((await committer.listDirectory(10)).blocks).toEqual([]);
  });

  // 跨代次块必须在写入之前被拒：写进去就等于把块挂进了别的代次，且不可撤回。
  test("跨代次块在写入前被拒，存储与目录都不得出现该 docId", async () => {
    const { store, committer } = await createCommitContext();
    const foreign = buildContentBlock({
      generation: "gen_verify_other",
      blockIndex: 0,
      records: [record(1, 16)],
      targetPayloadBytes: 1 << 16,
      hardLimitBytes: 1 << 16,
      rand: deterministicRandomSource("foreign"),
      digest: sha256Digest,
    });
    const failure = await captureError(() => committer.commitBlock(foreign));
    expect(failure.code).toBe("GENERATION_MISMATCH");
    expect(await store.readDocStateAt(foreign.docId, 0)).toBeNull();
    expect((await committer.listDirectory(10)).blocks).toEqual([]);
  });
});
