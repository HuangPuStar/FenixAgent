// packages/chat-channel/src/sync/history/ingest.ts
// 历史导入的入口接收适配器（设计 §5.1 / §5.3）：编号、有界校验、大帧单任务路径与顺序暂存。
//
// 四条不变式（每条都有测试）：
// ① `sourceOrdinal` 由本模块签发、从 1 起连续，并在第一个 `await` 之前分配：并发 `accept` 的编号顺序 = 调用
//    顺序 = 追加顺序，所以「ordinal → 字节区间」是一段可复原的连续流；
// ② 被拒的提交（重复对象、越限、额度拒绝）不消耗 ordinal —— 编号连续 ⇔ 每个 ordinal 恰好对应一个对象；
// ③ 接收窗口是 `[begin, markReceivingComplete)`，窗口外 `accept` 一律 `IMPORT_INCOMPLETE`；冻结必须先于任何
//    异步构建任务分派（设计 §5.3 [R5]）；④ 大帧同一时刻只允许一个，且必须先取 `frameParse` 额度。
//
// 刻意不做跨 load 去重（设计 §5.3）：没有稳定源身份时不启用增量去重，内容相同的两条消息都必须保留。身份只在
// 本实例的接收窗口内参与重复判定，实例释放即消失。
//
// 偏差记录（规格未规定的读取缝）：§5.3 只定义写入口，而 §5.7 的 `buildAndCommit` 必须按 ordinal 消费暂存字节，
// `SpoolTask` 句柄却只在本模块内。故补两个**只读**出口：`readRecord`（按 ordinal 定位）与 `stagedManifest`
// （已封存 manifest）。它们不新增写入路径，也不改变任何不变式；若 C2 另有读取方案可整体删除。
//
// 暂存布局：保真字节按 ordinal 顺序首尾相接，不加 framing（长度与摘要由 `IngestedRecord` 回给调用方），因此
// 第 k 个对象的区间是 `[Σ_{i<k} bytes_i, +bytes_k)`，`status().totalBytes` 即流长度。

import type { AdmissionController, Reservation } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import type { Clock, DigestFn } from "../clock";
import { asSyncProtocolError, SyncProtocolError, type SyncSafeContext } from "../protocol/errors";
import { assertIdentifier } from "../protocol/identity";
import { fidelitySerialize, scanJsonText } from "./fidelity-json";
import type { HistorySpool, SpoolManifest, SpoolTask } from "./spool";

/** 历史记录的三种来源形态：整对象、长文本/长载荷片段、工具对象（设计 §4.2 的扁平记录 kind）。 */
export type HistoryRecordKind = "history_object" | "text_part" | "tool_object";

/** 记录头（不含正文）：身份、槽位与拼接位置。 */
export interface HistoryRecordMeta {
  kind: HistoryRecordKind;
  /** 逻辑消息/工具入口身份。给出时必须是合法标识（非空、≤256 UTF-8 字节、无控制字符）；缺省时该记录没有
   * 可判定身份，不参与重复对象判定（设计 §5.3：没有稳定源身份就不去重，内容相同的对象都要保留）。 */
  entryId?: string;
  /** 同一条消息内的内容槽位；参与重复对象判定（缺省与显式 `0` 视为不同槽位，不替调用方猜语义）。 */
  contentSlot?: number;
  /** 片段序号（长载荷拆成多片时的拼接位置）；参与重复对象判定。 */
  partIndex?: number;
}

/** 接受结果：调用方据此记住「哪个 ordinal 是哪个 kind 的多少字节、摘要是什么」。 */
export interface IngestedRecord {
  loadId: string;
  generation: string;
  /** 本次 load 内从 1 起的接收顺序；跨 load 不复用（重试换新 loadId，旧编号不是幂等键）。 */
  sourceOrdinal: number;
  kind: HistoryRecordKind;
  /** 保真序列化后的字节数，不含任何 framing（暂存流就是这些字节按序首尾相接）。 */
  payloadBytes: number;
  /** 保真字节的摘要，供块构建与完整性校验比对。 */
  digest: string;
}

/** 接收窗口状态：`idle` 尚未 begin / `receiving` 窗口内 / `receivingComplete` 边界已冻结（规格 §5.3）。 */
type IngestState = "idle" | "receiving" | "receivingComplete";

/** 归一化后的记录头：缺省字段收敛成 `null`，重复判定与身份键都不必再做 `undefined` 分叉。 */
interface NormalizedMeta {
  kind: HistoryRecordKind;
  entryId: string | null;
  contentSlot: number | null;
  partIndex: number | null;
}

/** 一个 ordinal 在暂存流中的位置；`length` 恒等于对应 `IngestedRecord.payloadBytes`。 */
interface StagedRange {
  offset: number;
  length: number;
}

/** 一次接收尝试的全部可变状态：整体创建、整体替换，避免出现「有 task 没有 loadId」这类半状态组合。 */
interface ReceivingAttempt {
  readonly loadId: string;
  readonly generation: string;
  readonly scopeKey: string;
  /** 进入接收窗口的墙钟时刻（注入的 `Clock`）；只用于失败诊断里的「已接收多久」。 */
  readonly startedAt: number;
  readonly task: SpoolTask;
  /** 已暂存对象数与字节数：只在落盘成功后推进，描述的是「已暂存的」内容。 */
  objectCount: number;
  totalBytes: number;
  /** 已分配的字节流长度 = 下一个记录的偏移；与 ordinal 同刻分配，故与追加顺序一致。 */
  allocatedBytes: number;
  /** 最后一个已分配的 ordinal；`0` 表示尚未接收任何对象。 */
  lastOrdinal: number;
  /** 在途 accept 数：冻结边界时必须为 0，否则索引会漏掉已入队但尚未落盘的记录。 */
  inFlight: number;
  largeFrameInFlight: boolean;
  /** 记录身份 → ordinal：同一身份第二次提交即重复对象（只在本 load 的窗口内有效）。 */
  identities: Map<string, number>;
  /** ordinal → 暂存字节区间，供 `readRecord` 定位。 */
  ranges: Map<number, StagedRange>;
  /** 冻结回执：`markReceivingComplete` 启动它，`stagedManifest` 等待它；非 `null` 即边界已冻结。 */
  seal: Promise<SpoolManifest> | null;
  /** 撕裂后的失败原因：非 `null` 时所有写入口都以它拒绝（带洞的编号空间不再可能成为完整导入）。 */
  failure: SyncProtocolError | null;
}

/** canonical 文本解码器：输入字节来自本模块的 `fidelitySerialize`，必然是合法 UTF-8。 */
const CANONICAL_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 非法输入统一出口：message 只描述字段与违规类型，绝不回显内容。 */
function malformed(message: string): SyncProtocolError {
  return new SyncProtocolError("MALFORMED_FRAME", { message });
}

/** kind 是记录结构的第一分叉：未知 kind 说明调用方与帧格式脱节，必须在写入任何字节之前拒绝。 */
function assertRecordKind(value: unknown): HistoryRecordKind {
  switch (value) {
    case "history_object":
    case "text_part":
    case "tool_object":
      return value;
    default:
      throw malformed("unknown history record kind");
  }
}

/** `entryId` 是重复判定的唯一来源：给出时必须是合法标识（非空、≤256 字节、无控制字符）。 */
function requireEntryId(value: unknown): string {
  if (typeof value !== "string") {
    throw malformed('record meta "entryId" must be a string');
  }
  assertIdentifier(value, "entryId");
  return value;
}

/** 槽位与片段号必须是非负安全整数：负数或小数会让「第几片」在重组时不可解释。 */
function optionalIndex(value: unknown, field: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`record meta "${field}" must be a non-negative integer`);
  }
  return value;
}

/** 校验并归一化记录头；字段全程可选，但给出即必须合法（缺省字段不猜测语义，见 `identityOf`）。 */
function normalizeMeta(meta: HistoryRecordMeta): NormalizedMeta {
  if (typeof meta !== "object" || meta === null) {
    throw malformed("record meta must be an object");
  }
  return {
    kind: assertRecordKind(meta.kind),
    entryId: meta.entryId === undefined ? null : requireEntryId(meta.entryId),
    contentSlot: optionalIndex(meta.contentSlot, "contentSlot"),
    partIndex: optionalIndex(meta.partIndex, "partIndex"),
  };
}

/**
 * 记录身份 = `kind` + `entryId` + `contentSlot` + `partIndex`。规格里「同一 `sourceOrdinal` 二次提交」与「已接收
 * 对象再提交」在本模块是同一件事：ordinal 由本模块签发，调用方无法自带 ordinal，重复只能表现为「同一身份第二次
 * 提交」；没有 `entryId` 时返回 `null`——没有稳定源身份就不去重（设计 §5.3），内容相同的对象都必须保留。
 */
function identityOf(meta: NormalizedMeta): string | null {
  if (meta.entryId === null) {
    return null;
  }
  return JSON.stringify([meta.kind, meta.entryId, meta.contentSlot, meta.partIndex]);
}

/**
 * 保真序列化 + 解析前的有界扫描（设计 §4.3.4）：只 stringify 一次，字节口径由保真层唯一决定；扫描在 canonical
 * 文本上进行，字节、深度、节点、非有限数字与非法转义都在这里收敛，且都先于占用任何额度与落暂存。字节上限取
 * §10.2 的原始帧上限：canonical 与源帧同量级，超限说明源帧本身超限，应在最早的可控入口失败。
 */
function serializeRecord(value: unknown, capacity: SyncCapacityProfile): Uint8Array {
  const bytes = fidelitySerialize(value);
  scanJsonText(CANONICAL_DECODER.decode(bytes), {
    maxBytes: capacity.inputs.maxRawAcpFrameBytes,
    maxDepth: capacity.inputs.jsonMaxDepth,
    maxNodes: capacity.inputs.jsonMaxNodes,
  });
  return bytes;
}

/**
 * 入口接收适配器：把一个 load 的历史对象变成「连续编号 + 顺序暂存字节」。
 *
 * 一个实例同时只承载一次尝试；配额与段文件都在注入的暂存器里，本模块不持有任何全局状态。
 */
export class HistoryIngest {
  private readonly spool: HistorySpool;
  /** 只用于失败诊断里的「已接收时长」：接收窗口本身没有时限（规格 §5.3 未定义超时）。 */
  private readonly clock: Clock;
  private readonly digest: DigestFn;
  private readonly capacity: SyncCapacityProfile;
  /** 缺省时大帧没有额度可依：宁可拒绝，也不做无额度的大帧接收（§10.1「缺配置拒绝启用」）。 */
  private readonly admission: AdmissionController | null;
  private state: IngestState = "idle";
  /**
   * 不变式：`state === "idle"` ⇔ `attempt === null`，两者只在 `begin` / `markReceivingComplete` 一起改写。
   * `begin` 等待暂存任务期间会短暂出现「`receiving` 但 `attempt` 为空」的过渡态：该状态下 `accept` 报窗口未开、
   * 并发 `begin` 被 `SCOPE_BUSY` 拒绝，因此不会有第二个暂存任务被建出来。
   */
  private attempt: ReceivingAttempt | null = null;

  constructor(deps: {
    spool: HistorySpool;
    clock: Clock;
    digest: DigestFn;
    capacity: SyncCapacityProfile;
    admission?: AdmissionController;
  }) {
    this.spool = deps.spool;
    this.clock = deps.clock;
    this.digest = deps.digest;
    this.capacity = deps.capacity;
    this.admission = deps.admission ?? null;
  }

  /**
   * 开始一次接收尝试：登记暂存任务并打开接收窗口。允许重入的只有三种情形：首次（`idle`）、上一次边界已冻结
   * 后换新 loadId 继续（`receivingComplete`）、上一次撕裂后用新 loadId 重试（`receiving` 且已标记失败）；
   * 窗口敞着时再次 `begin` 一律 `SCOPE_BUSY`——两个 load 共用同一编号空间会让 ordinal 与字节流静默穿插。
   */
  async begin(input: { scopeKey: string; generation: string; loadId: string }): Promise<void> {
    const previousState = this.state;
    const attempt = this.attempt;
    if (previousState === "receiving" && (attempt === null || attempt.failure === null)) {
      throw new SyncProtocolError("SCOPE_BUSY", {
        retryable: false,
        message: "ingest is still receiving: a new attempt requires either a frozen boundary or a failed one",
        safeContext: this.context(),
      });
    }
    assertIdentifier(input.scopeKey, "scopeKey");
    assertIdentifier(input.generation, "generation");
    // 同步先占窗口：并发的第二次 begin 会看到「接收中」并被 SCOPE_BUSY 拒绝，不会建出第二个暂存任务。
    this.state = "receiving";
    let task: SpoolTask;
    try {
      // loadId 的标识校验与「单段路径」约束在暂存器一侧（目录名即 loadId，权威只有一处）。
      task = await this.spool.beginTask(input.loadId);
    } catch (error) {
      this.state = previousState; // 建任务失败：窗口退回原状态，调用方可用新 loadId 重试
      throw error;
    }
    this.attempt = {
      loadId: input.loadId,
      generation: input.generation,
      scopeKey: input.scopeKey,
      startedAt: this.clock.now(),
      task,
      objectCount: 0,
      totalBytes: 0,
      allocatedBytes: 0,
      lastOrdinal: 0,
      inFlight: 0,
      largeFrameInFlight: false,
      identities: new Map(),
      ranges: new Map(),
      seal: null,
      failure: null,
    };
  }

  /** 接收一个完整历史对象：先做有界校验与保真序列化，再占用额度并顺序暂存；返回本次编号结果。 */
  async accept(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord> {
    const attempt = this.requireReceivingWindow();
    const normalized = normalizeMeta(meta);
    const identity = identityOf(normalized);
    if (identity !== null) {
      const held = attempt.identities.get(identity);
      if (held !== undefined) {
        // 同一身份已经收过一次：不覆盖、不追加。去重只在本 load 窗口内成立，重试必须换新 loadId。
        throw new SyncProtocolError("DUPLICATE_OBJECT", {
          message: `record identity already accepted at ordinal ${held}`,
          safeContext: this.context(held),
        });
      }
    }
    const bytes = serializeRecord(value, this.capacity);
    const payloadBytes = bytes.byteLength;
    const digest = this.digest(bytes);
    const reservation = this.enterLargeFramePath(payloadBytes);
    // 编号与偏移在任何 await 之前一起分配：并发 accept 的 ordinal 顺序 = 调用顺序 = 追加顺序，
    // 暂存流因此是一段与编号同构的连续字节。
    const sourceOrdinal = attempt.lastOrdinal + 1;
    const offset = attempt.allocatedBytes;
    attempt.lastOrdinal = sourceOrdinal;
    attempt.allocatedBytes = offset + payloadBytes;
    attempt.inFlight += 1;
    try {
      await attempt.task.append(bytes);
    } catch (error) {
      // 暂存失败即整批失败：暂存器已归还配额并抛弃任务（spool 的失败分支），这里只标记尝试撕裂——编号空间
      // 已留下补不齐的洞，继续接收只会写向已删除的目录并把真实原因盖成 RESOURCE_RETIRED。
      const cause = asSyncProtocolError(error, "STAGING_FAILED");
      const elapsedMs = this.clock.now() - attempt.startedAt;
      attempt.failure = new SyncProtocolError(cause.code, {
        message: `record ${sourceOrdinal} failed to stage after ${elapsedMs}ms of receiving`,
        safeContext: this.context(sourceOrdinal),
        cause,
      });
      throw attempt.failure;
    } finally {
      attempt.inFlight -= 1;
      if (reservation !== null) {
        attempt.largeFrameInFlight = false;
      }
      reservation?.release();
    }
    // 只有落盘成功才记账（失败路径已在上面抛出并标记撕裂）：两个计数因此始终描述已暂存的字节。
    attempt.objectCount += 1;
    attempt.totalBytes += payloadBytes;
    attempt.ranges.set(sourceOrdinal, { offset, length: payloadBytes });
    if (identity !== null) {
      attempt.identities.set(identity, sourceOrdinal);
    }
    return {
      loadId: attempt.loadId,
      generation: attempt.generation,
      sourceOrdinal,
      kind: normalized.kind,
      payloadBytes,
      digest,
    };
  }

  /** 记录接收边界：load 响应的最后 sourceOrdinal；必须在分派异步构建任务之前调用。 */
  markReceivingComplete(lastOrdinal: number): void {
    const attempt = this.attempt;
    if (attempt === null) {
      throw this.incomplete("ingest has no open receiving window");
    }
    if (attempt.failure !== null) {
      // 撕裂的尝试无法冻结出一个自洽边界：先报真实失败原因，调用方据此换新 loadId 重试。
      throw attempt.failure;
    }
    if (!Number.isSafeInteger(lastOrdinal) || lastOrdinal < 0) {
      throw malformed("receiving boundary must be a non-negative integer");
    }
    if (attempt.seal !== null) {
      // 冻结是状态而非动作：同一边界重复调用幂等（load 响应重传），改口说明调用方在重定义本次接收范围。
      if (attempt.lastOrdinal !== lastOrdinal) {
        throw this.incomplete(`receiving boundary ${lastOrdinal} differs from the frozen ${attempt.lastOrdinal}`);
      }
      return;
    }
    if (attempt.inFlight > 0) {
      // 在途对象已拿到编号但还没进索引：此刻冻结会让索引漏掉已入队字节（§5.3 [R5] 要求先编号再分派）。
      throw this.incomplete("cannot freeze the receiving boundary while records are still in flight");
    }
    if (attempt.lastOrdinal !== lastOrdinal) {
      // 边界必须与「同一有序接收入口」的最后一个编号一致：更小会静默丢掉已接收对象，更大说明对象没到齐。
      throw this.incomplete(
        `receiving boundary ${lastOrdinal} does not match the last received ordinal ${attempt.lastOrdinal}`,
      );
    }
    this.state = "receivingComplete";
    // 同步状态迁移就是「边界冻结」，必须先于任何异步构建任务分派完成；暂存器的封存只是这次冻结的回执，由
    // `stagedManifest()` 等待（保证段与总长是最终值）。预先挂一个空处理：无人等待回执时的失败会变成未处理
    // 拒绝，而错误本身仍由 `stagedManifest()` 原样上抛。
    const seal = attempt.task.seal();
    void seal.catch(() => undefined);
    attempt.seal = seal;
  }

  /** 当前尝试的观察点：未 begin 时返回空闲零值；撕裂后仍报 `receiving`（状态集由规格冻结为三态）。 */
  status(): { state: IngestState; objectCount: number; lastOrdinal: number; totalBytes: number } {
    const attempt = this.attempt;
    return {
      state: this.state,
      objectCount: attempt?.objectCount ?? 0,
      lastOrdinal: attempt?.lastOrdinal ?? 0,
      totalBytes: attempt?.totalBytes ?? 0,
    };
  }

  /**
   * 按 `sourceOrdinal` 读回暂存字节（`spool.readRange` + 本模块的编号索引），供块构建消费。未 begin、编号从未
   * 被暂存（含撕裂留下的洞）一律 `IMPORT_INCOMPLETE`：缺口必须显式失败，不能返回短读或空字节把「缺块」伪装成
   * 「空内容」。
   */
  async readRecord(sourceOrdinal: number): Promise<Uint8Array> {
    const attempt = this.attempt;
    if (attempt === null) {
      throw this.incomplete("ingest has no open receiving window");
    }
    const manifest = await this.resolveManifest(attempt);
    const range = attempt.ranges.get(sourceOrdinal);
    if (range === undefined) {
      throw this.incomplete(`ordinal ${sourceOrdinal} was never staged`, sourceOrdinal);
    }
    return this.spool.readRange(manifest, range.offset, range.length);
  }

  /**
   * 当前尝试的暂存 manifest（未 `begin` 时为 `null`）：规格 §5.3 没规定这个出口，但 §5.2 要求构建期按 ordinal
   * 消费暂存字节，而 `SpoolTask` 句柄只在本模块内——调用方需要 manifest 才能调用 `spool.readRange`。只读；
   * 边界已冻结时返回的是已封存的 manifest。
   */
  async stagedManifest(): Promise<SpoolManifest | null> {
    const attempt = this.attempt;
    if (attempt === null) {
      return null;
    }
    return this.resolveManifest(attempt);
  }

  /** manifest 解析：已冻结等封存回执（含冲刷在途追加），未冻结取当前快照。 */
  private async resolveManifest(attempt: ReceivingAttempt): Promise<SpoolManifest> {
    return attempt.seal ?? attempt.task.manifest;
  }

  /** 接收窗口检查：窗口是 `[begin, markReceivingComplete)`，窗口外（未 begin、已冻结、已撕裂）一律拒绝。 */
  private requireReceivingWindow(): ReceivingAttempt {
    const attempt = this.attempt;
    if (attempt === null) {
      throw this.incomplete("ingest has no open receiving window");
    }
    if (attempt.failure !== null) {
      throw attempt.failure;
    }
    if (this.state !== "receiving" || attempt.seal !== null) {
      throw this.incomplete("receiving boundary is frozen: accept is closed");
    }
    return attempt;
  }

  /**
   * 大帧单任务路径（§10.1「同时最多 1 个 >1MiB 对象」）：超阈值时先占唯一的单任务槽，再取 `frameParse` 额度，
   * 返回需要释放的预留（小帧为 `null`）。顺序不可交换：先查并发槽，第二个并发大帧才会报出规格要求的
   * `CAPACITY_EXCEEDED`，而不是被额度不足掩盖成 `ADMISSION_REJECTED`。
   */
  private enterLargeFramePath(payloadBytes: number): Reservation | null {
    if (payloadBytes <= this.capacity.inputs.largeFrameThresholdBytes) {
      return null;
    }
    const attempt = this.attempt;
    if (attempt === null) {
      // 目前只有 `accept` 会走到这里，窗口必然有效；保留判定，避免将来新增调用点时绕过窗口检查。
      throw this.incomplete("ingest has no open receiving window");
    }
    if (attempt.largeFrameInFlight) {
      throw new SyncProtocolError("CAPACITY_EXCEEDED", {
        message: `a large frame is already in flight: ${payloadBytes} bytes cannot start until it finishes`,
        safeContext: this.context(),
      });
    }
    const admission = this.admission;
    if (admission === null) {
      throw new SyncProtocolError("ADMISSION_REJECTED", {
        message: "large frames require an injected admission controller for the frameParse pool",
        safeContext: this.context(),
      });
    }
    attempt.largeFrameInFlight = true;
    try {
      return admission.reserve("frameParse", payloadBytes);
    } catch (error) {
      // 额度不足时立刻让出单任务槽：否则后续大帧会被判成「已有大帧在飞」，掩盖真实的额度原因。
      attempt.largeFrameInFlight = false;
      throw error;
    }
  }

  /** 完整性与窗口类错误统一出口：只带 scope/generation/ordinal，不带正文。 */
  private incomplete(message: string, ordinal?: number): SyncProtocolError {
    return new SyncProtocolError("IMPORT_INCOMPLETE", { message, safeContext: this.context(ordinal) });
  }

  /** 安全上下文：只放 `SyncSafeContext` 声明的字段（scope 用 `scopeKey` 字符串），禁止正文、路径与凭据。 */
  private context(ordinal?: number): SyncSafeContext {
    const context: SyncSafeContext = {};
    if (this.attempt !== null) {
      context.scope = this.attempt.scopeKey;
      context.generation = this.attempt.generation;
    }
    if (ordinal !== undefined) {
      context.ordinal = ordinal;
    }
    return context;
  }
}
