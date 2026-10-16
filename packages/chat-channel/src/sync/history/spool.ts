// packages/chat-channel/src/sync/history/spool.ts
// 历史导入的顺序分段暂存（设计 §5.1）：本机磁盘上的配额化字节缓冲，队列只持有「文件位置 + 长度」。
//
// 三条不变式：① 同一任务的操作全进任务内串行队列，段文件绝不交错写；② 临时文件不是持久化事实（§5.1.4）——
// 进程或磁盘丢失即该批次失败、重新 load 新 generation，故不承诺 fsync、不做跨进程恢复，残留目录交由
// cleanupOrphans；③ 配额先计提再落盘，超限立刻抛 CAPACITY_EXCEEDED 并回收本任务已写段。
//
// 已知边界（影响 + 移除条件）：只有任务级释放——块构建消费过的段要等 completeTask 才消失（§5.2.6 的
// 「释放已消费段」未落地，移除条件 = 出现「构建与释放时间重叠」的调用方时补段级释放 API）；配额账目只在
// 进程内，跨进程的「同 scope 唯一恢复任务位置」由上层协调器保证（§5.1.1）；段文件删除失败不改变「任务已
// 释放」的结论——残留不占额度、由 cleanupOrphans（§9.4 启动清理）兜底，清理阶段的次生失败刻意不上抛。

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../clock";
import type { SyncErrorCode } from "../protocol/errors";
import { SyncProtocolError } from "../protocol/errors";
import { assertIdentifier } from "../protocol/identity";

/** 暂存目录与三档配额，全部经构造参数注入（模块内不读进程环境）；三项字节数均为正整数。 */
export interface SpoolConfig {
  /** 所有 load 任务目录的父目录；不存在则按需创建。 */
  basePath: string;
  /** 单段字节上限：段满即开新段；超过 `taskQuotaBytes` 会被配置校验拒绝。 */
  segmentBytes: number;
  taskQuotaBytes: number;
  processQuotaBytes: number;
}

/** 一个段的位置与长度；`path` 是本机绝对路径，只作排障用，不得进入同步帧或透给客户端。 */
export interface SpoolSegment {
  /** 段序号：从 0 起按写入顺序递增，与文件名的定宽数字一致。 */
  index: number;
  path: string;
  /** 段内已写字节数（除最后一段外等于 `segmentBytes`）。 */
  bytes: number;
  /** 该段首字节在任务字节流中的偏移，用于按范围定位段。 */
  startOffset: number;
}

/** 任务字节流的目录：段列表 + 总长度 + 是否已冻结接收边界。 */
export interface SpoolManifest {
  loadId: string;
  segments: SpoolSegment[];
  totalBytes: number;
  /** `seal()` 之后为 `true`：接收边界已冻结，不再接受追加。 */
  sealed: boolean;
}

/** 任务内部账目：只在暂存器内部流动，不随 `SpoolTask` 暴露，避免调用方绕过配额改字节数。 */
interface SpoolTaskState {
  readonly loadId: string;
  readonly dir: string;
  readonly segments: SpoolSegment[];
  /** 已落盘字节：`manifest.totalBytes` 与段 `startOffset` 的唯一来源。 */
  bytesWritten: number;
  /** 已计提配额（含写入在途字节），只在任务释放时归还，防止并发任务同时通过检查后冲爆总量。 */
  reservedBytes: number;
  /** `sealed` 冻结接收边界；`closed` 表示任务已释放或已放弃——关闭后任何写入都必须失败。 */
  sealed: boolean;
  closed: boolean;
  /** 任务内串行队列的游标，见 `enqueue`。 */
  chain: Promise<void>;
}

/** 任务句柄与暂存器之间的窄接口：合法实例只能由 `HistorySpool.beginTask` 签发。 */
interface SpoolTaskOps {
  append(bytes: Uint8Array): Promise<void>;
  seal(): Promise<SpoolManifest>;
  bytesWritten(): number;
  manifest(): SpoolManifest;
}

/** 失败诊断文件名：`failTask` 保留它供离线排查；它不是业务真相，也不作恢复输入。 */
const FAILURE_FILE_NAME = "failure.json";
const ENOENT = "ENOENT";

function spoolError(code: SyncErrorCode, message: string, cause?: unknown): SyncProtocolError {
  return new SyncProtocolError(code, cause === undefined ? { message } : { message, cause });
}

/** 最小范围收窄：Node 的 fs 异常不是导出类型，只取它可移植的 `code` 字段。 */
function errnoOf(error: unknown): string | null {
  const { code } = error instanceof Error ? (error as { code?: unknown }) : { code: undefined };
  return typeof code === "string" ? code : null;
}

/** 收敛 I/O 异常：已分类的协议错误原样上抛（缺失段不能被降级成暂存失败），其余包成 STAGING_FAILED，message
 * 只带操作名与 errno——绝不回显路径。 */
function ioFailure(operation: string, error: unknown): SyncProtocolError {
  if (error instanceof SyncProtocolError) {
    return error;
  }
  const errno = errnoOf(error);
  return spoolError("STAGING_FAILED", `spool ${operation} failed${errno === null ? "" : ` (${errno})`}`, error);
}

/** 配置校验是暂存层唯一的启用门禁：`segmentBytes` 超过任务配额必须拒绝而不是夹取，否则单段就能冲破配额。 */
function assertSpoolConfig(config: SpoolConfig): void {
  if (typeof config.basePath !== "string" || config.basePath.length === 0) {
    throw spoolError("ADMISSION_REJECTED", 'spool config "basePath" must be a non-empty path');
  }
  for (const field of ["segmentBytes", "taskQuotaBytes", "processQuotaBytes"] as const) {
    if (!Number.isInteger(config[field]) || config[field] <= 0) {
      throw spoolError("ADMISSION_REJECTED", `spool config "${field}" must be a positive integer`);
    }
  }
  if (config.segmentBytes > config.taskQuotaBytes) {
    throw spoolError("ADMISSION_REJECTED", 'spool config "segmentBytes" must not exceed "taskQuotaBytes"');
  }
}

/** manifest 快照：段数组与段对象都复制，调用方改写不会污染任务内部账目。 */
function snapshotManifest(state: SpoolTaskState): SpoolManifest {
  return {
    loadId: state.loadId,
    segments: state.segments.map((segment) => ({ ...segment })),
    totalBytes: state.bytesWritten,
    sealed: state.sealed,
  };
}

/** 任务内串行队列：一次追加是「查配额 → 计提 → 落盘 → 记账」的多步序列，只有同一任务完整串行，段偏移与配额
 * 才不会互相踩踏（跨任务目录独立，无需串行）。游标吞掉链上返回值：否则一次配额拒绝会让整条链永久 rejected。 */
function enqueue<T>(state: SpoolTaskState, operation: () => Promise<T>): Promise<T> {
  const run = state.chain.then(operation);
  state.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 打开段文件；缺失是「暂存字节不完整」而非暂存故障，故单独映射成 IMPORT_INCOMPLETE。 */
async function openSegmentFile(segment: SpoolSegment, flags: "a" | "r"): Promise<FileHandle> {
  try {
    return await open(segment.path, flags);
  } catch (error) {
    if (errnoOf(error) === ENOENT) {
      throw spoolError("IMPORT_INCOMPLETE", `spool segment ${segment.index} is missing`);
    }
    throw ioFailure("open", error);
  }
}

/** 追加写入单个段文件：短写必须补齐；主路径上的关闭失败视为暂存失败（数据可能未落盘）。 */
async function appendToSegment(segment: SpoolSegment, chunk: Uint8Array): Promise<void> {
  const handle = await openSegmentFile(segment, "a");
  try {
    let written = 0;
    while (written < chunk.length) {
      const result = await handle.write(chunk.subarray(written));
      // 没有这个出口就是死循环：拿不到进展必须立刻失败，而不是空转到超时。
      if (result.bytesWritten <= 0) {
        throw spoolError("STAGING_FAILED", "spool segment write made no progress");
      }
      written += result.bytesWritten;
    }
  } catch (error) {
    // 主错误优先：关闭句柄的失败不得掩盖写失败的原因。
    await handle.close().catch(() => undefined);
    throw ioFailure("write", error);
  }
  await handle.close();
}

/** 读取段内切片：短读说明暂存字节不完整，一律 IMPORT_INCOMPLETE（调用方只应重试整批，不做局部修补）。 */
async function readSegmentSlice(segment: SpoolSegment, offset: number, count: number): Promise<Uint8Array> {
  const handle = await openSegmentFile(segment, "r");
  const buffer = new Uint8Array(count);
  try {
    const { bytesRead } = await handle.read(buffer, 0, count, offset);
    if (bytesRead !== count) {
      throw spoolError("IMPORT_INCOMPLETE", `spool segment ${segment.index} returned ${bytesRead} of ${count} bytes`);
    }
  } finally {
    // 读取完成后关闭失败不改变结果，且不得顶替上面更精确的错误。
    await handle.close().catch(() => undefined);
  }
  return buffer;
}

/** 删除任务目录；失败只留下可被 `cleanupOrphans` 回收的残留，不影响已归还的配额（见文件头的已知边界）。 */
async function removeDirectoryQuietly(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // 残留目录不占额度，由 cleanupOrphans（设计 §9.4 启动清理）回收。
  }
}

/** 历史暂存器：按 loadId 管理分段文件、配额与读取窗口；一个实例即一个进程的暂存面（配额只在本实例内结算），
 * 任务句柄由 `beginTask` 签发，外部不持有内部账目。 */
export class HistorySpool {
  private readonly config: SpoolConfig;
  private readonly clock: Clock;
  /** 在册任务：键即目录名。`beginTask` 先同步占位再落盘，重复 loadId 不会并发建同一目录。 */
  private readonly tasks = new Map<string, SpoolTaskState>();
  /** 进程总量账目：Σ 已计提配额，只随 reserve/release 变化。 */
  private totalBytes = 0;

  constructor(config: SpoolConfig, clock: Clock) {
    assertSpoolConfig(config);
    // 配置快照：构造后调用方改写传入对象不得改变配额口径，否则已计提用量可能反超上限。
    this.config = { ...config };
    this.clock = clock;
  }

  /** 开始一个 load 的暂存任务（按需建目录）；目录已有内容即拒绝——重试必须换新 loadId（§5.1.4），混写更贵。 */
  async beginTask(loadId: string): Promise<SpoolTask> {
    // loadId 直接用作目录名：既受标识约束（非空、无控制字符、≤256 字节）也必须是单段路径，否则它就是任意路径写入原语。
    assertIdentifier(loadId, "loadId");
    if (loadId === "." || loadId === ".." || loadId.includes("/") || loadId.includes("\\")) {
      throw spoolError("MALFORMED_FRAME", 'identifier "loadId" must be a single path segment');
    }
    if (this.tasks.has(loadId)) {
      // 同 loadId 复用是调用方缺陷（重试必须换 loadId），因此显式关掉可重试语义。
      const message = `spool task "${loadId}" is already active`;
      throw new SyncProtocolError("SCOPE_BUSY", { retryable: false, message });
    }
    const state: SpoolTaskState = {
      loadId,
      dir: join(this.config.basePath, loadId),
      segments: [],
      bytesWritten: 0,
      reservedBytes: 0,
      sealed: false,
      closed: false,
      chain: Promise.resolve(),
    };
    // 先同步占位再 await：否则并发的同 loadId 请求会各自建目录并同时写同一批段文件。
    this.tasks.set(loadId, state);
    try {
      await mkdir(state.dir, { recursive: true });
      if ((await readdir(state.dir)).length > 0) {
        throw spoolError("IMPORT_INCOMPLETE", `spool task "${loadId}" directory is not empty`);
      }
    } catch (error) {
      // 尚未写入任何字节，不涉及配额归还；目录内容留给 cleanupOrphans。
      this.tasks.delete(loadId);
      throw ioFailure("prepare", error);
    }
    return new SpoolTask(loadId, {
      append: (bytes) => this.appendToTask(state, bytes),
      seal: () =>
        enqueue(state, async () => {
          if (state.closed) {
            throw spoolError("RESOURCE_RETIRED", `spool task "${state.loadId}" is released`);
          }
          // 冻结是状态而非动作：重复封存返回同一 manifest。
          state.sealed = true;
          return snapshotManifest(state);
        }),
      bytesWritten: () => state.bytesWritten,
      manifest: () => snapshotManifest(state),
    });
  }

  /** 按范围读取已暂存内容：请求必须完全落在 `manifest.totalBytes` 内，不返回短读结果（否则上层会把截断字节当成
   * 完整对象）；已释放或非本进程在册的任务一律 RESOURCE_RETIRED，参数非法报 MALFORMED_FRAME。 */
  async readRange(manifest: SpoolManifest, startOffset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(startOffset) || startOffset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw spoolError("MALFORMED_FRAME", "spool readRange requires a non-negative integer offset and length");
    }
    // 用减法判越界：`startOffset + length` 可能溢出安全整数区间，绕过直接比较。
    if (length > manifest.totalBytes - startOffset) {
      throw spoolError("IMPORT_INCOMPLETE", `spool readRange ${startOffset}+${length} exceeds ${manifest.totalBytes}`);
    }
    if (!this.tasks.has(manifest.loadId)) {
      throw spoolError("RESOURCE_RETIRED", `spool task "${manifest.loadId}" is not active: segments were released`);
    }
    const out = new Uint8Array(length);
    const end = startOffset + length;
    let cursor = startOffset;
    for (const segment of manifest.segments) {
      if (cursor >= end) {
        break;
      }
      const segmentEnd = segment.startOffset + segment.bytes;
      if (segmentEnd <= cursor) {
        continue;
      }
      // 段之间必须无缝衔接：出现空洞说明 manifest 与磁盘状态不一致，不能靠拼接掩盖。
      if (segment.startOffset > cursor) {
        break;
      }
      const to = Math.min(segmentEnd, end);
      const chunk = await readSegmentSlice(segment, cursor - segment.startOffset, to - cursor);
      out.set(chunk, cursor - startOffset);
      cursor = to;
    }
    if (cursor !== end) {
      throw spoolError("IMPORT_INCOMPLETE", `range ${startOffset}+${length} not covered by spooled segments`);
    }
    return out;
  }

  /** 释放任务：删除全部段文件并归还配额。幂等——未知 loadId 一律视为已处理，补偿路径会重复调用。 */
  async completeTask(loadId: string): Promise<void> {
    const state = this.tasks.get(loadId);
    if (state === undefined) {
      return;
    }
    // 先关闸再排队：队列里尚未执行的 append 会看到 closed 并拒绝，不会在删除后重建段文件。
    state.closed = true;
    await enqueue(state, () => this.discardTask(state));
  }

  /**
   * 标记任务失败：保留已落盘段与失败诊断（供离线排查），立即归还配额；未知 loadId 视为已处理。
   *
   * 归还配额不依赖磁盘状态：段目录可能已被外部 `cleanupOrphans`（设计 §9.4）清掉，此时诊断写不进去，
   * 但额度必须已归还——否则一次失败就长期占住进程配额，且重试无法自愈。写失败时任务留在册上（额度已归零、
   * 入口已关闭），调用方重试本方法即可在目录恢复后补写诊断并撤出在册。
   */
  async failTask(loadId: string, reason: string): Promise<void> {
    const state = this.tasks.get(loadId);
    if (state === undefined) {
      return;
    }
    state.closed = true;
    await enqueue(state, async () => {
      // 先归还再落盘：诊断是排查副产品，不能因为写不进去就让额度留在账上（`releaseQuota` 幂等，重试安全）。
      this.releaseQuota(state);
      const payload = JSON.stringify({ loadId, reason, failedAt: this.clock.now() });
      try {
        await writeFile(join(state.dir, FAILURE_FILE_NAME), payload, "utf8");
      } catch (error) {
        throw ioFailure("write-failure-marker", error);
      }
      this.tasks.delete(loadId);
    });
  }

  /** 清理孤儿任务目录：删除既不在 `knownLoadIds` 也不在本进程在册的目录，返回删除的条目数；在册任务永不删除。 */
  async cleanupOrphans(knownLoadIds: string[]): Promise<number> {
    // 本进程在册的任务永不删除：它们是活动写入目标，误删会让正在进行的导入写进空洞。
    const keep = new Set([...knownLoadIds, ...this.tasks.keys()]);
    let names: string[];
    try {
      names = await readdir(this.config.basePath);
    } catch (error) {
      if (errnoOf(error) === ENOENT) {
        // 目录整体不存在说明还没有任何任务落盘：无清理面，也不必为此创建目录。
        return 0;
      }
      throw ioFailure("readdir", error);
    }
    let removed = 0;
    for (const name of names) {
      if (keep.has(name)) {
        continue;
      }
      try {
        await rm(join(this.config.basePath, name), { recursive: true, force: true });
      } catch (error) {
        // 中途失败即整体抛出：返回一个「清理了多少」的模糊数字比失败更难排查，调用方可整体重试。
        throw ioFailure("rm-orphan", error);
      }
      removed += 1;
    }
    return removed;
  }

  /** 配额账目快照。口径是「已计提配额」而非磁盘实际字节：在途字节已占额度，账面必须同时反映它。返回新的 Map。 */
  stats(): { taskBytes: Map<string, number>; totalBytes: number } {
    const taskBytes = new Map<string, number>();
    for (const [loadId, state] of this.tasks) {
      taskBytes.set(loadId, state.reservedBytes);
    }
    return { taskBytes, totalBytes: this.totalBytes };
  }

  /** 追加一段字节；空追加不建段、不占额度（每次空响应都建段会让目录迅速膨胀成噪声）。 */
  private async appendToTask(state: SpoolTaskState, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) {
      return;
    }
    // 调用方可能在排队期间复用同一缓冲，入队前先取快照，保证写入的就是调用那一刻的字节。
    const payload = bytes.slice();
    await enqueue(state, async () => {
      if (state.closed) {
        throw spoolError("RESOURCE_RETIRED", `spool task "${state.loadId}" is released`);
      }
      if (state.sealed) {
        throw spoolError("IMPORT_INCOMPLETE", `spool task "${state.loadId}" is sealed: boundary is frozen`);
      }
      const violation = this.quotaViolation(state, payload.length);
      if (violation !== null) {
        await this.discardTask(state);
        throw spoolError("CAPACITY_EXCEEDED", `spool capacity exceeded: ${violation}`);
      }
      this.reserveQuota(state, payload.length);
      try {
        await this.writeChunks(state, payload);
      } catch (error) {
        await this.discardTask(state);
        throw ioFailure("write", error);
      }
    });
  }

  /** 顺序落盘：段满 `segmentBytes` 即开新段，单次追加可跨多段；段的长度上界是读取定位与磁盘结算的前提。 */
  private async writeChunks(state: SpoolTaskState, payload: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < payload.length) {
      const current = state.segments.at(-1);
      const segment =
        current === undefined || current.bytes >= this.config.segmentBytes ? this.openSegment(state) : current;
      const take = Math.min(this.config.segmentBytes - segment.bytes, payload.length - offset);
      await appendToSegment(segment, payload.subarray(offset, offset + take));
      segment.bytes += take;
      state.bytesWritten += take;
      offset += take;
    }
  }

  /** 开新段并登记；`startOffset` 取自当前已落盘字节，因此每段在字节流中的位置天然连续。 */
  private openSegment(state: SpoolTaskState): SpoolSegment {
    const index = state.segments.length;
    const segment: SpoolSegment = {
      index,
      path: join(state.dir, `segment-${String(index).padStart(6, "0")}.bin`),
      bytes: 0,
      startOffset: state.bytesWritten,
    };
    state.segments.push(segment);
    return segment;
  }

  /** 配额判定：按「计提值 + 本次字节」判上限；判定与计提之间不允许出现 await，否则并发任务会一起冲爆总量。 */
  private quotaViolation(state: SpoolTaskState, extra: number): string | null {
    const taskWouldHold = state.reservedBytes + extra;
    if (taskWouldHold > this.config.taskQuotaBytes) {
      return `task "${state.loadId}" would hold ${taskWouldHold} bytes, limit ${this.config.taskQuotaBytes}`;
    }
    const processWouldHold = this.totalBytes + extra;
    if (processWouldHold > this.config.processQuotaBytes) {
      return `process would hold ${processWouldHold} bytes, limit ${this.config.processQuotaBytes}`;
    }
    return null;
  }

  private reserveQuota(state: SpoolTaskState, bytes: number): void {
    state.reservedBytes += bytes;
    this.totalBytes += bytes;
  }

  /** 归还该任务全部已计提额度；幂等，重复调用不会把账目减成负数。 */
  private releaseQuota(state: SpoolTaskState): void {
    this.totalBytes -= state.reservedBytes;
    state.reservedBytes = 0;
  }

  /** 放弃任务：归还配额、撤出在册、删除段文件；删除失败不回滚前两步——任务已释放，残留由 cleanupOrphans 兜底。 */
  private async discardTask(state: SpoolTaskState): Promise<void> {
    state.closed = true;
    this.releaseQuota(state);
    this.tasks.delete(state.loadId);
    await removeDirectoryQuietly(state.dir);
  }
}

/** 暂存任务句柄：只暴露「追加 / 封存 / 观察」三件事，账目与串行队列都由暂存器一侧持有，无绕过配额的入口。 */
export class SpoolTask {
  /** 任务标识，与目录名一致；只用于诊断与 manifest 关联。 */
  readonly loadId: string;
  private readonly ops: SpoolTaskOps;

  /** 由 `HistorySpool.beginTask` 构造：ops 由暂存器闭包签发，外部拿不到合法实例。 */
  constructor(loadId: string, ops: SpoolTaskOps) {
    this.loadId = loadId;
    this.ops = ops;
  }

  /** 顺序追加一段字节；并发调用由内部串行队列排序，返回时本段已落盘。 */
  append(bytes: Uint8Array): Promise<void> {
    return this.ops.append(bytes);
  }

  /** 冻结接收边界并返回最终 manifest；幂等，重复调用返回同一结果。 */
  seal(): Promise<SpoolManifest> {
    return this.ops.seal();
  }

  /** 已落盘字节数，等于当前 manifest 的 `totalBytes`。 */
  get bytesWritten(): number {
    return this.ops.bytesWritten();
  }

  /** 当前 manifest 快照；含本机绝对路径，属于内部数据，禁止写入帧、日志或响应。 */
  get manifest(): SpoolManifest {
    return this.ops.manifest();
  }
}
