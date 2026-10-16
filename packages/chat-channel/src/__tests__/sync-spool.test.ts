// packages/chat-channel/src/__tests__/sync-spool.test.ts
// 顺序暂存（规格 §5.2）的行为验收：分段顺序写、任务/进程双档配额、范围读取、释放与孤儿清理。
// 全部走真实文件系统（`os.tmpdir` + `mkdtemp`），配额用小数值注入，避免真写 2GiB 级数据。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../sync/clock";
import { HistorySpool, type SpoolConfig } from "../sync/history/spool";
import { SyncProtocolError } from "../sync/protocol/errors";

const SEGMENT_BYTES = 64;
const TASK_QUOTA_BYTES = 256;
const PROCESS_QUOTA_BYTES = 512;
const FIXED_NOW = 1_700_000_000_000;

/** 时间源固定：`failTask` 诊断里的时间戳必须可逐字断言。 */
const fixedClock: Clock = { now: () => FIXED_NOW };

/** 本文件创建的临时根目录；用例结束整体删除，避免把暂存残留留在系统临时目录里。 */
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 建一个空临时根目录，返回其下尚未创建的 `spool` 子目录路径（目录由暂存器按需创建）。 */
async function createBasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sync-spool-"));
  tempRoots.push(root);
  return join(root, "spool");
}

/** 小配额配置字面量：单段 64B / 单任务 256B / 进程 512B，各项可被单个用例覆盖。 */
function spoolConfig(basePath: string, overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  return {
    basePath,
    segmentBytes: SEGMENT_BYTES,
    taskQuotaBytes: TASK_QUOTA_BYTES,
    processQuotaBytes: PROCESS_QUOTA_BYTES,
    ...overrides,
  };
}

/** 建暂存器并回传它的 basePath：多数断言要同时观察账目与磁盘残留。 */
async function createSpool(overrides: Partial<SpoolConfig> = {}): Promise<{ spool: HistorySpool; basePath: string }> {
  const basePath = await createBasePath();
  return { spool: new HistorySpool(spoolConfig(basePath, overrides), fixedClock), basePath };
}

/** 捕获同步协议错误：非本层异常原样抛出，避免把断言失败误判成「确实抛了错」。 */
async function captureSpoolError(run: () => unknown): Promise<SyncProtocolError> {
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

/** 测试字节：每个字节由全局偏移推导，跨段拼接一旦错位，内容比对立刻暴露。 */
function patternBytes(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = (offset + index) % 251;
  }
  return out;
}

/** 目录是否存在：回收语义要区分「账目归零」与「磁盘仍有残留」。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("配置与准入", () => {
  // 配置校验是唯一的启用门禁：越界或非正整数的配额必须在构造期拒绝，否则段上界与配额都不成立。
  test("构造期拒绝非法配额配置", async () => {
    const basePath = await createBasePath();
    const invalidOverrides: Partial<SpoolConfig>[] = [
      { segmentBytes: 512, taskQuotaBytes: 64 },
      { segmentBytes: 0 },
      { taskQuotaBytes: -1 },
      { processQuotaBytes: 1.5 },
      { basePath: "" },
    ];
    for (const override of invalidOverrides) {
      const config = spoolConfig(basePath, override);
      const error = await captureSpoolError(() => new HistorySpool(config, fixedClock));
      expect(error.code).toBe("ADMISSION_REJECTED");
    }
  });

  // loadId 直接充当目录名：含路径分隔符或为相对段的输入等于任意路径写入原语，必须建目录前拒绝。
  test("loadId 含路径分隔符或为相对段时被拒", async () => {
    const { spool } = await createSpool();
    for (const loadId of ["", ".", "..", "a/b", "a\\b", "../escape"]) {
      const error = await captureSpoolError(() => spool.beginTask(loadId));
      expect(error.code).toBe("MALFORMED_FRAME");
    }
  });

  // 同 loadId 二次 beginTask 是调用方缺陷（重试必须换 loadId），显式关掉可重试语义以免两条流混写同一目录。
  test("重复 beginTask 同一 loadId 报 SCOPE_BUSY 且不可重试", async () => {
    const { spool } = await createSpool();
    await spool.beginTask("task-dup");
    const error = await captureSpoolError(() => spool.beginTask("task-dup"));
    expect(error.code).toBe("SCOPE_BUSY");
    expect(error.retryable).toBe(false);
  });

  // 目录已有内容说明上一批没清干净，续写会与残留字节混成无法归属的流，必须拒绝而不是追加。
  test("beginTask 遇到非空任务目录报 IMPORT_INCOMPLETE", async () => {
    const { spool, basePath } = await createSpool();
    const dir = join(basePath, "task-dirty");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "segment-000000.bin"), new Uint8Array(4));
    const error = await captureSpoolError(() => spool.beginTask("task-dirty"));
    expect(error.code).toBe("IMPORT_INCOMPLETE");
  });
});

describe("顺序写入与分段", () => {
  // 单次追加跨段时偏移必须连续无缝：任何缝隙都会让后续范围读取拿到错位内容。
  test("顺序追加跨段且段偏移连续", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("task-segments");
    await task.append(patternBytes(0, 150));
    const manifest = task.manifest;
    expect(manifest.loadId).toBe("task-segments");
    expect(manifest.segments.map((segment) => [segment.index, segment.startOffset, segment.bytes])).toEqual([
      [0, 0, 64],
      [1, 64, 64],
      [2, 128, 22],
    ]);
    expect(manifest.totalBytes).toBe(150);
    expect(manifest.sealed).toBe(false);
    expect(task.bytesWritten).toBe(150);
    expect((await readdir(join(basePath, "task-segments"))).sort()).toEqual([
      "segment-000000.bin",
      "segment-000001.bin",
      "segment-000002.bin",
    ]);
  });

  // 空追加不建段也不占额度：否则每次空响应都建段会把任务目录迅速膨胀成噪声。
  test("空追加不建段、不占配额", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("task-empty");
    await task.append(new Uint8Array(0));
    expect(task.manifest.segments).toEqual([]);
    expect(task.bytesWritten).toBe(0);
    expect(spool.stats().totalBytes).toBe(0);
    expect(await readdir(join(basePath, "task-empty"))).toEqual([]);
  });

  // 并发追加必须整体串行：交错写会让同一段内的字节顺序错乱，逐块内容比对是最直接的证据。
  test("并发追加按调用顺序串行落盘", async () => {
    const { spool } = await createSpool();
    const task = await spool.beginTask("task-concurrent");
    const pending: Promise<void>[] = [];
    for (let index = 0; index < 8; index += 1) {
      pending.push(task.append(new Uint8Array(32).fill(index)));
    }
    await Promise.all(pending);
    const manifest = await task.seal();
    expect(manifest.totalBytes).toBe(256);
    const bytes = await spool.readRange(manifest, 0, 256);
    const blocks: number[][] = [];
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const block = Array.from(bytes.subarray(offset, offset + 32));
      blocks.push([new Set(block).size, block[0]]);
    }
    expect(blocks).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
      [1, 5],
      [1, 6],
      [1, 7],
    ]);
  });

  // manifest 是快照：调用方改写返回值不得污染内部账目，否则一次误改就会让后续写入偏移错位。
  test("manifest 是调用方改写不了的快照", async () => {
    const { spool } = await createSpool();
    const task = await spool.beginTask("task-snapshot");
    await task.append(patternBytes(0, 70));
    const first = task.manifest;
    first.segments[0].bytes = 999;
    first.segments.push({ index: 9, path: "/tmp/not-real", bytes: 1, startOffset: 999 });
    first.totalBytes = 999;
    const second = task.manifest;
    expect(second.segments).toHaveLength(2);
    expect(second.segments[0].bytes).toBe(64);
    expect(second.totalBytes).toBe(70);
  });
});

describe("配额", () => {
  // 超配额必须整批失败：留下的半截段会被下一次尝试当成完整前缀，故任务要立刻回收并归还额度。
  test("单任务超配额抛 CAPACITY_EXCEEDED 并回收已写段", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("task-over");
    await task.append(patternBytes(0, 200));
    const manifest = task.manifest;
    const error = await captureSpoolError(() => task.append(patternBytes(200, 100)));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("task");
    const stats = spool.stats();
    expect(stats.totalBytes).toBe(0);
    expect(stats.taskBytes.size).toBe(0);
    expect(await pathExists(join(basePath, "task-over"))).toBe(false);
    expect((await captureSpoolError(() => spool.readRange(manifest, 0, 10))).code).toBe("RESOURCE_RETIRED");
    expect((await captureSpoolError(() => task.append(patternBytes(0, 4)))).code).toBe("RESOURCE_RETIRED");
  });

  // 进程总量是最后一道闸：两个各自未超限的任务也不能一起冲破它，被拒者只回收自己、不牵连别人。
  test("进程总量超配额时明确拒绝并保留其它任务额度", async () => {
    const { spool, basePath } = await createSpool();
    const first = await spool.beginTask("task-a");
    await first.append(patternBytes(0, 256));
    const second = await spool.beginTask("task-b");
    await second.append(patternBytes(0, 256));
    expect(spool.stats().totalBytes).toBe(512);
    const third = await spool.beginTask("task-c");
    const error = await captureSpoolError(() => third.append(patternBytes(0, 1)));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(error.message).toContain("process");
    const stats = spool.stats();
    expect(stats.totalBytes).toBe(512);
    expect(stats.taskBytes.get("task-a")).toBe(256);
    expect(stats.taskBytes.get("task-b")).toBe(256);
    expect(stats.taskBytes.has("task-c")).toBe(false);
    expect(await pathExists(join(basePath, "task-c"))).toBe(false);
    // 释放一个任务后额度必须真的还回来，否则第一次拒绝会把后续导入永久卡死。
    await spool.completeTask("task-a");
    expect(spool.stats().totalBytes).toBe(256);
    const fourth = await spool.beginTask("task-d");
    await fourth.append(patternBytes(0, 256));
    expect(spool.stats().totalBytes).toBe(512);
  });
});

describe("范围读取", () => {
  // 跨段读取是最常见的调用形态：段边界处必须无缝拼接，错一字节就污染恢复出来的对象。
  test("readRange 跨段读取内容逐字节一致", async () => {
    const { spool } = await createSpool();
    const task = await spool.beginTask("task-read");
    await task.append(patternBytes(0, 150));
    const manifest = task.manifest;
    const expected = patternBytes(0, 150);
    const crossing = await spool.readRange(manifest, 60, 50);
    expect(Array.from(crossing)).toEqual(Array.from(expected.subarray(60, 110)));
    const head = await spool.readRange(manifest, 0, 64);
    expect(Array.from(head)).toEqual(Array.from(expected.subarray(0, 64)));
    const tail = await spool.readRange(manifest, 140, 10);
    expect(Array.from(tail)).toEqual(Array.from(expected.subarray(140, 150)));
    expect(await spool.readRange(manifest, 150, 0)).toHaveLength(0);
  });

  // 读取必须完全落在已暂存范围内：短读会让上层把截断字节当成完整对象，非法参数则属于调用方缺陷。
  test("readRange 越界与非法参数被拒且不改变任务状态", async () => {
    const { spool } = await createSpool();
    const task = await spool.beginTask("task-range");
    await task.append(patternBytes(0, 100));
    const manifest = task.manifest;
    expect((await captureSpoolError(() => spool.readRange(manifest, 60, 60))).code).toBe("IMPORT_INCOMPLETE");
    expect((await captureSpoolError(() => spool.readRange(manifest, 0, Number.MAX_SAFE_INTEGER))).code).toBe(
      "IMPORT_INCOMPLETE",
    );
    expect((await captureSpoolError(() => spool.readRange(manifest, -1, 5))).code).toBe("MALFORMED_FRAME");
    expect((await captureSpoolError(() => spool.readRange(manifest, 0, -1))).code).toBe("MALFORMED_FRAME");
    expect((await captureSpoolError(() => spool.readRange(manifest, 0, 1.5))).code).toBe("MALFORMED_FRAME");
    expect(spool.stats().totalBytes).toBe(100);
    expect(Array.from(await spool.readRange(manifest, 0, 10))).toEqual(Array.from(patternBytes(0, 10)));
  });

  // 段文件在外部被删掉时必须报 IMPORT_INCOMPLETE：静默返回短字节会让上层把空洞当成有效内容。
  test("段文件缺失时读取报 IMPORT_INCOMPLETE", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("task-missing");
    await task.append(patternBytes(0, 100));
    const manifest = task.manifest;
    await rm(join(basePath, "task-missing", "segment-000001.bin"));
    expect((await captureSpoolError(() => spool.readRange(manifest, 70, 10))).code).toBe("IMPORT_INCOMPLETE");
    expect(Array.from(await spool.readRange(manifest, 0, 10))).toEqual(Array.from(patternBytes(0, 10)));
  });
});

describe("释放、失败与清理", () => {
  // seal 冻结接收边界但字节仍须可读：构建阶段要在封存后取材，重复封存返回同一结果。
  test("seal 冻结边界且幂等，封存后拒绝追加", async () => {
    const { spool } = await createSpool();
    const task = await spool.beginTask("task-seal");
    await task.append(patternBytes(0, 100));
    const sealed = await task.seal();
    expect(sealed.sealed).toBe(true);
    expect(sealed.totalBytes).toBe(100);
    expect((await task.seal()).sealed).toBe(true);
    expect(Array.from(await spool.readRange(sealed, 90, 10))).toEqual(Array.from(patternBytes(90, 10)));
    expect((await captureSpoolError(() => task.append(patternBytes(100, 4)))).code).toBe("IMPORT_INCOMPLETE");
    expect(task.bytesWritten).toBe(100);
  });

  // 完成任务即释放：额度归还、段文件删除、后续读写明确失败，重复调用不得报错（补偿路径会重放）。
  test("completeTask 释放配额并撤下读写面", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("task-done");
    await task.append(patternBytes(0, 100));
    const manifest = task.manifest;
    await spool.completeTask("task-done");
    const stats = spool.stats();
    expect(stats.totalBytes).toBe(0);
    expect(stats.taskBytes.size).toBe(0);
    expect(await pathExists(join(basePath, "task-done"))).toBe(false);
    expect((await captureSpoolError(() => spool.readRange(manifest, 0, 10))).code).toBe("RESOURCE_RETIRED");
    expect((await captureSpoolError(() => task.append(patternBytes(0, 4)))).code).toBe("RESOURCE_RETIRED");
    expect((await captureSpoolError(() => task.seal())).code).toBe("RESOURCE_RETIRED");
    await spool.completeTask("task-done");
    await spool.failTask("task-done", "late");
    expect(await pathExists(join(basePath, "task-done"))).toBe(false);
  });

  // 释放与在途追加竞态：释放先关闸，排队中的追加必须失败且不得把段文件重建回磁盘。
  test("释放后在途追加失败且不重建段文件", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("task-race");
    const pending = captureSpoolError(() => task.append(patternBytes(0, 100)));
    await spool.completeTask("task-race");
    expect((await pending).code).toBe("RESOURCE_RETIRED");
    expect(task.manifest.segments).toEqual([]);
    expect(await pathExists(join(basePath, "task-race"))).toBe(false);
    expect(spool.stats().totalBytes).toBe(0);
  });

  // 失败任务保留段与诊断供离线排查，但额度必须立刻归还，否则一次失败会长期占住进程配额。
  test("failTask 保留诊断文件并归还配额", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("task-failed");
    await task.append(patternBytes(0, 100));
    const manifest = task.manifest;
    await spool.failTask("task-failed", "upstream aborted");
    const stats = spool.stats();
    expect(stats.totalBytes).toBe(0);
    expect(stats.taskBytes.size).toBe(0);
    const dir = join(basePath, "task-failed");
    expect((await readdir(dir)).sort()).toEqual(["failure.json", "segment-000000.bin", "segment-000001.bin"]);
    expect(JSON.parse(await readFile(join(dir, "failure.json"), "utf8"))).toEqual({
      loadId: "task-failed",
      reason: "upstream aborted",
      failedAt: FIXED_NOW,
    });
    expect((await captureSpoolError(() => spool.readRange(manifest, 0, 10))).code).toBe("RESOURCE_RETIRED");
    expect((await captureSpoolError(() => task.append(patternBytes(0, 4)))).code).toBe("RESOURCE_RETIRED");
    // 二次调用是已处理：诊断文件保持首次原因，不被重放的补偿调用覆盖。
    await spool.failTask("task-failed", "again");
    const kept = JSON.parse(await readFile(join(dir, "failure.json"), "utf8"));
    expect(kept.reason).toBe("upstream aborted");
  });

  // 孤儿目录只可能是崩溃残留：只删既不在已知集合也不在册的目录，活动任务与已知 loadId 必须完好。
  test("cleanupOrphans 删除未知残留并返回删除数量", async () => {
    const { spool, basePath } = await createSpool();
    const task = await spool.beginTask("live-task");
    await task.append(patternBytes(0, 10));
    const knownDir = join(basePath, "known-load");
    await mkdir(join(knownDir, "nested"), { recursive: true });
    await writeFile(join(knownDir, "segment-000000.bin"), new Uint8Array(4));
    for (const name of ["orphan-a", "orphan-b"]) {
      await mkdir(join(basePath, name), { recursive: true });
      await writeFile(join(basePath, name, "segment-000000.bin"), new Uint8Array(4));
    }
    expect(await spool.cleanupOrphans(["known-load"])).toBe(2);
    expect(await pathExists(join(basePath, "orphan-a"))).toBe(false);
    expect(await pathExists(join(basePath, "orphan-b"))).toBe(false);
    expect(await pathExists(knownDir)).toBe(true);
    expect(Array.from(await spool.readRange(task.manifest, 0, 10))).toEqual(Array.from(patternBytes(0, 10)));
    // basePath 整体不存在时没有清理面，返回 0 且不为此创建目录。
    const { spool: fresh, basePath: freshPath } = await createSpool();
    expect(await fresh.cleanupOrphans([])).toBe(0);
    expect(await pathExists(freshPath)).toBe(false);
  });
});
