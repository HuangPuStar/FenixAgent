// packages/chat-channel/src/__tests__/sync-runtime-profile.measure.ts
// D 阶段「短时资源与延迟」测量脚本：本机采样，既不是通过性门禁，也不是设计 §15.3 的固定 profile。
//
// 运行：cd <worktree 根> && bun run packages/chat-channel/src/__tests__/sync-runtime-profile.measure.ts
// 后缀 `.measure.ts` 让 bun test 不收集本文件；脚本内**没有断言**（不判通过/失败，只报数字），
// 结果由 `.peri/plans/chat-sync-runtime-profile-result.md` 逐条登记。无法在本环境测出的指标只打印原因，
// 不估算、不用相似数字顶替（设计 §15.3：硬件不满足时只能另报 profile，不能冒充本 profile 通过）。
//
// 三项指标与口径：
// 1) `apply`：单次 apply 延迟分位，走真实 `sync/client/doc-hub` 路径（enqueue → drain → Y.applyUpdate →
//    onOutcome 确认）。同载荷另测「直接 Y.applyUpdate」（不含 hub 调度与确认）与两种固定成本地板，
//    用于把调度开销与真正的 apply 成本分开看。
// 2) `import`：20,000 稳定对象导入吞吐。真实 `HistoryImportService` + `HistorySpool`（临时目录）+
//    `BlockBuildPool` + `MemoryProjectionStore`（本项目测量环境没有 PostgreSQL，内存 adapter 是唯一
//    可用实现）；导入期间按固定间隔采样进程 RSS/heap 并报峰值。载荷形状取设计 §15.3 标准历史突发：
//    19,900 个 4KiB 对象 + 100 个 228KiB 对象。
// 3) `hot`：热工作集趋势。连续 5 个批次，每批后测 `hub.loadedBytes()` 与 RSS；两种口径对照——
//    「同一 Doc 持续追加」（客户端正常在写）与「旧 Doc 释放后」（封存/退役副本不再驻留）。
//
// 环境：CPU 型号/核数、Bun 与 Yjs 版本、进程峰值 RSS 一并打印，供结果文件如实登记。

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

import { AdmissionController } from "../sync/capacity/admission";
import { CLIENT_BUDGET } from "../sync/capacity/profile";
import { type ApplyTask, createDocHub, type DocHub } from "../sync/client/doc-hub";
import { deterministicRandomSource, sha256Digest, systemClock } from "../sync/clock";
import { BlockBuildPool, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { fidelitySerialize } from "../sync/history/fidelity-json";
import { HistoryImportService } from "../sync/history/import-service";
import type { HistoryRecordMeta } from "../sync/history/ingest";
import { HistorySpool } from "../sync/history/spool";
import { buildDocId } from "../sync/protocol/identity";
import { resolveSyncRuntimeConfig } from "../sync/runtime/config";
import { MemoryProjectionStore } from "../sync/store/memory-store";

/** 固定身份：同一 generation/epoch/attempt 的 docId 形态与线上一致（`sync/<kind>/<gen>/<block>/<nonce>`）。 */
const GENERATION = "gen_0123456789abcdef0123456789abcdef";
const SUBSCRIPTION_EPOCH = "sub_0123456789abcdef";
const SYNC_ATTEMPT = "att_0123456789abcdef";

const MIB = 1024 * 1024;

/** apply 延迟样本量：规格要求 ≥2000。 */
const APPLY_SAMPLES = 2500;
/** 预热样本：不记录，只为让 Yjs/JIT 进入稳定态（否则 p50 会被前几十次的编译开销拉高）。 */
const APPLY_WARMUP = 300;
/** 单条载荷字节：与实时合并阈值（16KiB）之下的常规文本增量同量级。 */
const APPLY_PAYLOAD_BYTES = 1024;
/** 大载荷对照样本：设计 §10.2 的 `liveMergeMaxBytes` 量级，用来看 apply 成本的规模敏感度。 */
const APPLY_LARGE_PAYLOAD_BYTES = 16 * 1024;
const APPLY_LARGE_SAMPLES = 500;

/** 设计 §15.3 标准历史突发：19,900 个 4KiB 对象 + 100 个 228KiB 对象（目标规范化载荷约 100MiB）。 */
const IMPORT_SMALL_OBJECTS = 19_900;
const IMPORT_LARGE_OBJECTS = 100;
const IMPORT_SMALL_TARGET_BYTES = 4096;
const IMPORT_LARGE_TARGET_BYTES = 228 * 1024;
/** 峰值采样间隔：太小会自己扰动测量，太大可能漏掉构建期的瞬时峰值（结果文件登记该间隔）。 */
const MEMORY_SAMPLE_INTERVAL_MS = 20;

/** 热工作集：5 个批次、每批 2000 条增量（约 2MiB/批）。 */
const HOT_BATCHES = 5;
const HOT_UPDATES_PER_BATCH = 2000;
const HOT_PAYLOAD_BYTES = 1024;

// ---------------------------------------------------------------- 输出原语

/** 指标输出唯一格式：`key=value`；值只取数字或环境事实字符串，不做通过/失败判定。 */
function metric(key: string, value: number | string): void {
  console.log(`${key}=${value}`);
}

function section(name: string): void {
  console.log(`\n## ${name}`);
}

function toMib(bytes: number): number {
  return Number((bytes / MIB).toFixed(3));
}

function toMs(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * 最近秩分位（nearest-rank）：不插值，报出的数字一定是真实采样点。
 * 插值会把长尾平滑掉，而本项要看的正是 p99/最大值是否被个别慢样本拖走。
 */
function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil(quantile * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? Number.NaN;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 打印一组延迟样本的分位与总量：所有延迟指标共用同一口径，避免各段各写一套。 */
function reportLatency(prefix: string, samples: readonly number[]): void {
  const sorted = [...samples].sort((left, right) => left - right);
  metric(`${prefix}.samples`, sorted.length);
  metric(`${prefix}.p50Ms`, toMs(percentile(sorted, 0.5)));
  metric(`${prefix}.p95Ms`, toMs(percentile(sorted, 0.95)));
  metric(`${prefix}.p99Ms`, toMs(percentile(sorted, 0.99)));
  metric(`${prefix}.maxMs`, toMs(sorted[sorted.length - 1] ?? Number.NaN));
  metric(`${prefix}.meanMs`, toMs(mean(samples)));
}

// ---------------------------------------------------------------- 内存与 GC

interface MemoryReading {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
}

/** 进程峰值：现场采样到的上界，等价于「本次测量的进程 RSS 上限」证据。 */
let peakRssBytes = 0;
let peakHeapUsedBytes = 0;

/** 读当前内存并推进进程峰值；所有分区共用它，最终 `profile.*` 即全程观测到的上界。 */
function noteMemory(): MemoryReading {
  const usage = process.memoryUsage();
  const reading: MemoryReading = {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
  };
  peakRssBytes = Math.max(peakRssBytes, reading.rssBytes);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, reading.heapUsedBytes);
  return reading;
}

/**
 * 显式 GC：RSS 趋势比较必须先清掉上一阶段的垃圾，否则「增长」只反映分配器水位而不是工作集。
 * `Bun.gc(true)` 是同步全量 GC；非 Bun 环境跳过（本脚本只承诺在仓库的 Bun 版本上可运行）。
 */
function forceGc(): void {
  if (typeof Bun.gc === "function") {
    Bun.gc(true);
    return;
  }
}

interface PeakMemory {
  readonly peakRssBytes: number;
  readonly peakHeapUsedBytes: number;
  readonly samples: number;
  readonly elapsedMs: number;
}

/** 定间隔峰值采样器：异步导入期间由事件循环驱动，stop 时再补一次读数。 */
function startPeakSampler(intervalMs: number): { stop(): PeakMemory } {
  let sectionPeakRssBytes = 0;
  let sectionPeakHeapUsedBytes = 0;
  let samples = 0;
  const startedAt = performance.now();
  const read = (): void => {
    const memory = noteMemory();
    sectionPeakRssBytes = Math.max(sectionPeakRssBytes, memory.rssBytes);
    sectionPeakHeapUsedBytes = Math.max(sectionPeakHeapUsedBytes, memory.heapUsedBytes);
    samples += 1;
  };
  read();
  const timer = setInterval(read, intervalMs);
  return {
    stop(): PeakMemory {
      clearInterval(timer);
      read();
      return {
        peakRssBytes: sectionPeakRssBytes,
        peakHeapUsedBytes: sectionPeakHeapUsedBytes,
        samples,
        elapsedMs: toMs(performance.now() - startedAt),
      };
    },
  };
}

/** Yjs 版本：设计 §15.3 要求记录，跨版本比较延迟数字才有意义。解析失败只报 unknown，不猜。 */
function readYjsVersion(): string {
  try {
    const version = (
      JSON.parse(readFileSync(Bun.resolveSync("yjs/package.json", import.meta.dir), "utf8")) as {
        version?: unknown;
      }
    ).version;
    return typeof version === "string" ? version : "unknown";
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** 环境与本次测量口径：一次打印，结果文件按原样登记。 */
function reportEnvironment(): void {
  const cpuList = cpus();
  metric("env.cpuModel", cpuList[0]?.model ?? "unknown");
  metric("env.cpuCores", cpuList.length);
  metric("env.osTotalMemoryBytes", totalmem());
  metric("env.platform", `${platform()} ${release()} ${arch()}`);
  metric("env.bunVersion", Bun.version);
  metric("env.yjsVersion", readYjsVersion());
  metric("env.memorySampleIntervalMs", MEMORY_SAMPLE_INTERVAL_MS);
}

// ---------------------------------------------------------------- 载荷与任务构造

/** 一条文本增量流的载荷序列：同一写者 client 的连续 delta，与线上 DOC_UPDATE 字节同构。 */
function buildStreamingUpdates(count: number, chunkBytes: number): Uint8Array[] {
  const producer = new Y.Doc();
  const text = producer.getText("body");
  const updates: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    // 差分编码：先取状态向量，再插入，只编码本次插入的结构，避免载荷随文档线性膨胀。
    const stateVector = Y.encodeStateVector(producer);
    text.insert(text.length, `${index}:${"x".repeat(Math.max(1, chunkBytes - 8))}\n`);
    updates.push(Y.encodeStateAsUpdate(producer, stateVector));
  }
  producer.destroy();
  return updates;
}

/** 空快照：建基线的载荷（客户端 baseReady 之前只能从空 Doc 应用完整 snapshot，§8.4）。 */
function emptyUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const payload = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return payload;
}

let deliveryCounter = 0;

function nextDeliveryId(label: string): string {
  deliveryCounter += 1;
  return `dlv_${label}_${String(deliveryCounter).padStart(8, "0")}`;
}

function contentDocId(blockIndex: number, nonce: string): string {
  return buildDocId({ kind: "content", generation: GENERATION, blockIndex, nonce });
}

function makeTask(
  docId: string,
  kind: "base" | "update",
  fromSeq: number,
  toSeq: number,
  payload: Uint8Array,
  label: string,
): ApplyTask {
  return {
    kind,
    docId,
    generation: GENERATION,
    subscriptionEpoch: SUBSCRIPTION_EPOCH,
    syncAttemptId: SYNC_ATTEMPT,
    deliveryId: nextDeliveryId(label),
    fromSeq,
    toSeq,
    payload,
    digest: sha256Digest(payload),
  };
}

interface HubHarness {
  readonly hub: DocHub;
  readonly counts: { processed: number; rejected: number };
  readonly resyncs: string[];
  dispose(): void;
}

/**
 * 测量用 hub：接收队列与调度预算全部取自 `CLIENT_BUDGET`，与 `sync/client/transport.ts` 的装配同源，
 * 避免测量用的另一套预算把结论变得不可比。`now`/`yieldToHost` 走真实时间与宏任务让出。
 */
function createMeasureHub(): HubHarness {
  const counts = { processed: 0, rejected: 0 };
  const resyncs: string[] = [];
  const hub = createDocHub({
    maxQueueBytes: CLIENT_BUDGET.receiveQueueBytes,
    maxQueueTasks: CLIENT_BUDGET.receiveQueueTasks,
    budget: {
      maxBytes: CLIENT_BUDGET.receiveQueueBytes,
      maxTasks: CLIENT_BUDGET.receiveQueueTasks,
      maxMillis: CLIENT_BUDGET.applySliceTargetMs,
    },
    now: () => performance.now(),
    yieldToHost: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 0);
      }),
    onOutcome: (outcome) => {
      if (outcome.result === "processed") {
        counts.processed += 1;
      } else {
        counts.rejected += 1;
      }
    },
    onResyncRequired: (docId, reason) => {
      resyncs.push(`${docId}:${reason}`);
    },
  });
  return { hub, counts, resyncs, dispose: () => hub.dispose() };
}

/** 建立可信基线：base 帧经 hub 入队并 apply，之后才允许连续增量（§8.4）。 */
async function primeBase(hub: DocHub, docId: string, label: string): Promise<void> {
  hub.retain(docId);
  hub.enqueue(makeTask(docId, "base", 0, 0, emptyUpdate(), label));
  await hub.drain();
}

interface BatchFeedResult {
  readonly appendedBytes: number;
  readonly lastSeq: number;
}

/**
 * 按真实接收路径喂帧：入队规模受有界队列（`CLIENT_BUDGET.receiveQueueTasks`）限制，
 * 每半个队列就 drain 一次——与 transport「onmessage 入队 + 调度 drain」同构，不绕过队列预算。
 */
async function feedUpdates(
  hub: DocHub,
  docId: string,
  updates: readonly Uint8Array[],
  startSeq: number,
  label: string,
): Promise<BatchFeedResult> {
  const chunk = Math.max(1, Math.floor(CLIENT_BUDGET.receiveQueueTasks / 2));
  let appendedBytes = 0;
  let seq = startSeq;
  for (let index = 0; index < updates.length; index += 1) {
    const payload = updates[index];
    if (payload === undefined) {
      break;
    }
    seq += 1;
    hub.enqueue(makeTask(docId, "update", seq, seq, payload, label));
    appendedBytes += payload.byteLength;
    if ((index + 1) % chunk === 0) {
      await hub.drain();
    }
  }
  await hub.drain();
  return { appendedBytes, lastSeq: seq };
}

// ---------------------------------------------------------------- 1) 单次 apply 延迟

/** 单次 apply 端到端时延：入队前取时，drain 返回（含 onOutcome 确认）后取时。 */
async function timeSingleApplies(
  hub: DocHub,
  docId: string,
  updates: readonly Uint8Array[],
  startSeq: number,
  label: string,
): Promise<number[]> {
  const samples: number[] = [];
  let seq = startSeq;
  for (let index = 0; index < updates.length; index += 1) {
    const payload = updates[index];
    if (payload === undefined) {
      break;
    }
    seq += 1;
    const startedAt = performance.now();
    hub.enqueue(makeTask(docId, "update", seq, seq, payload, label));
    await hub.drain();
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

async function measureApplyLatency(): Promise<void> {
  section("apply-latency（真实 doc-hub apply 路径，单条载荷 = 1KiB / 16KiB）");

  // 预热：独立文档 + 独立载荷流，样本丢弃；只让实现进入稳定态。
  const warmupHub = createMeasureHub();
  const warmupDocId = contentDocId(1, "nonce-warmup");
  await primeBase(warmupHub.hub, warmupDocId, "warmup");
  await timeSingleApplies(
    warmupHub.hub,
    warmupDocId,
    buildStreamingUpdates(APPLY_WARMUP, APPLY_PAYLOAD_BYTES),
    0,
    "warm",
  );
  warmupHub.dispose();

  // 主样本：1KiB 载荷、2500 次。
  const payloads = buildStreamingUpdates(APPLY_SAMPLES, APPLY_PAYLOAD_BYTES);
  const payloadBytes = payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
  const harness = createMeasureHub();
  const docId = contentDocId(2, "nonce-apply-1k");
  await primeBase(harness.hub, docId, "apply1k");
  const startedAt = performance.now();
  const samples = await timeSingleApplies(harness.hub, docId, payloads, 0, "apply1k");
  const wallMs = performance.now() - startedAt;

  metric("apply.payloadTargetBytes", APPLY_PAYLOAD_BYTES);
  metric("apply.payloadMeanBytes", Number((payloadBytes / payloads.length).toFixed(2)));
  metric("apply.payloadTotalBytes", payloadBytes);
  metric("apply.wallMs", toMs(wallMs));
  metric("apply.processedCount", harness.counts.processed);
  metric("apply.rejectedCount", harness.counts.rejected);
  metric("apply.resyncRequestCount", harness.resyncs.length);
  metric("apply.loadedBytesAfterRun", harness.hub.loadedBytes());
  reportLatency("apply.hub1k", samples);

  // 地板一：空队列 drain（只含 promise/microtask 往返，不含取队与 apply）。
  const emptyDrainSamples: number[] = [];
  for (let index = 0; index < APPLY_SAMPLES; index += 1) {
    const start = performance.now();
    await harness.hub.drain();
    emptyDrainSamples.push(performance.now() - start);
  }
  reportLatency("apply.emptyDrainFloor", emptyDrainSamples);

  // 地板二：极小载荷（32B）经完整 hub 路径的固定成本（取队 + apply + onOutcome）。
  const tinyUpdates = buildStreamingUpdates(APPLY_LARGE_SAMPLES, 32);
  const tinySamples = await timeSingleApplies(harness.hub, docId, tinyUpdates, payloads.length, "applytiny");
  reportLatency("apply.tinyPayloadPathFloor", tinySamples);

  // 对照：同一批载荷直接 Y.applyUpdate（不含 hub 的入队/调度/确认），用来分解成本。
  const plainDoc = new Y.Doc();
  Y.applyUpdate(plainDoc, emptyUpdate());
  const plainSamples: number[] = [];
  for (const payload of payloads) {
    const start = performance.now();
    Y.applyUpdate(plainDoc, payload);
    plainSamples.push(performance.now() - start);
  }
  plainDoc.destroy();
  reportLatency("apply.plainApply1k", plainSamples);

  harness.dispose();

  // 规模敏感度：16KiB 载荷（设计 liveMergeMaxBytes 量级），样本数较少，只作对照。
  const largeHarness = createMeasureHub();
  const largeDocId = contentDocId(3, "nonce-apply-16k");
  await primeBase(largeHarness.hub, largeDocId, "apply16k");
  const largePayloads = buildStreamingUpdates(APPLY_LARGE_SAMPLES, APPLY_LARGE_PAYLOAD_BYTES);
  const largeSamples = await timeSingleApplies(largeHarness.hub, largeDocId, largePayloads, 0, "apply16k");
  metric(
    "apply.largePayloadMeanBytes",
    Number((largePayloads.reduce((sum, payload) => sum + payload.byteLength, 0) / largePayloads.length).toFixed(2)),
  );
  metric("apply.largePayloadProcessedCount", largeHarness.counts.processed);
  reportLatency("apply.hub16k", largeSamples);
  largeHarness.dispose();

  const memory = noteMemory();
  metric("apply.peakRssBytes", peakRssBytes);
  metric("apply.afterRssBytes", memory.rssBytes);
  metric("apply.afterHeapUsedBytes", memory.heapUsedBytes);
}

// ---------------------------------------------------------------- 2) 历史导入吞吐

/**
 * 命令行覆盖（`--small=<n>` / `--large=<n>`）：默认即设计 §15.3 的历史突发形状。
 * 覆盖只用于把缺陷复现缩到最小规模（例如把 7 个块压到 193 个对象），不改任何生产代码、不读进程环境。
 */
function objectCountOverride(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const found = Bun.argv.find((argument) => argument.startsWith(prefix));
  if (found === undefined) {
    return fallback;
  }
  const parsed = Number(found.slice(prefix.length));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 构造规范化载荷恰好为 `targetBytes` 的对象：先量出骨架开销，再补齐文本，避免估算名义尺寸。 */
function sizedHistoryObject(index: number, targetBytes: number): Record<string, unknown> {
  const overhead = fidelitySerialize({ role: "assistant", index, text: "" }).byteLength;
  return { role: "assistant", index, text: "x".repeat(Math.max(1, targetBytes - overhead)) };
}

interface ImportOutcome {
  readonly completed: boolean;
  readonly state: string;
  readonly failureCode: string;
  readonly objectCount: number;
  readonly receivedOrdinal: number;
  readonly committedBlocks: number;
  readonly payloadBytes: number;
  readonly receiveMs: number;
  readonly buildMs: number;
  readonly finalizeMs: number;
  readonly peak: PeakMemory;
  readonly beforeRssBytes: number;
  readonly after: MemoryReading;
}

/**
 * 导入结果的全部数字集中在此输出。
 *
 * 三段口径严格分开：接收阶段耗时是**已成立的事实**（对象数与字节数都对得上）随时可报；
 * `import.total*` 只在导入真正跑完时才报——中途失败时的分段耗时是没有有效分母的，
 * 用部分字节折算出的吞吐就是编造的数字。
 */
function reportImportOutcome(outcome: ImportOutcome): void {
  metric("import.objects", outcome.objectCount);
  metric("import.payloadBytes", outcome.payloadBytes);
  metric("import.payloadMiB", toMib(outcome.payloadBytes));
  metric("import.receivedOrdinal", outcome.receivedOrdinal);
  metric("import.finalState", outcome.state);
  metric("import.failureCode", outcome.failureCode);
  metric("import.committedBlocks", outcome.committedBlocks);
  metric("import.peakSamplerSamples", outcome.peak.samples);
  metric("import.peakSamplerElapsedMs", outcome.peak.elapsedMs);
  metric("import.peakRssBytes", outcome.peak.peakRssBytes);
  metric("import.peakHeapUsedBytes", outcome.peak.peakHeapUsedBytes);
  metric("import.rssAfterGcBytes", outcome.after.rssBytes);
  metric("import.heapUsedAfterGcBytes", outcome.after.heapUsedBytes);
  metric("import.rssDeltaBytes", outcome.after.rssBytes - outcome.beforeRssBytes);

  if (outcome.receiveMs > 0) {
    const receiveSeconds = outcome.receiveMs / 1000;
    metric("import.receivePhase.ms", toMs(outcome.receiveMs));
    metric("import.receivePhase.objectsPerSecond", Number((outcome.objectCount / receiveSeconds).toFixed(1)));
    metric("import.receivePhase.mibPerSecond", Number((outcome.payloadBytes / MIB / receiveSeconds).toFixed(2)));
    metric("import.receivePhase.note", "仅接收+暂存阶段；导入未完成时它不是导入吞吐");
  }
  if (!outcome.completed) {
    metric("import.unavailable", `import ended in state ${outcome.state}`);
    return;
  }
  const totalMs = outcome.receiveMs + outcome.buildMs + outcome.finalizeMs;
  const totalSeconds = totalMs / 1000;
  metric("import.buildMs", toMs(outcome.buildMs));
  metric("import.finalizeMs", toMs(outcome.finalizeMs));
  metric("import.totalMs", toMs(totalMs));
  metric("import.totalObjectsPerSecond", Number((outcome.objectCount / totalSeconds).toFixed(1)));
  metric("import.totalMiBPerSecond", Number((outcome.payloadBytes / MIB / totalSeconds).toFixed(2)));
}

async function measureHistoryImport(tempRoot: string, smallObjects: number, largeObjects: number): Promise<void> {
  section(`history-import（${smallObjects} 个小对象 + ${largeObjects} 个大对象）`);

  // 暂存配额与块目标全部取 `resolveSyncRuntimeConfig` 派生的真实装配值，不另抄一份数值。
  const config = resolveSyncRuntimeConfig({
    clock: systemClock,
    random: deterministicRandomSource("sync-profile-measure"),
    lifecycle: { sealGraceMs: 30_000, retireGraceMs: 60_000 },
    spoolRootDir: join(tempRoot, "spool"),
  });
  const store = new MemoryProjectionStore({
    clock: systemClock,
    digest: sha256Digest,
    capacity: config.capacity,
    lifecycle: config.lifecycle,
  });
  const admission = new AdmissionController(config.capacity);
  const pool = new BlockBuildPool(deriveBuildPoolConfig(config.capacity.fairness), admission, systemClock);
  const spool = new HistorySpool(
    {
      basePath: config.spool.rootDir,
      segmentBytes: config.spool.segmentBytes,
      taskQuotaBytes: config.spool.taskQuotaBytes,
      processQuotaBytes: config.spool.processQuotaBytes,
    },
    systemClock,
  );
  const service = new HistoryImportService({
    store,
    spool,
    pool,
    clock: systemClock,
    digest: sha256Digest,
    capacity: config.capacity,
    rand: deterministicRandomSource("sync-profile-import"),
    admission,
  });

  metric("import.smallObjects", smallObjects);
  metric("import.largeObjects", largeObjects);
  metric("import.smallTargetBytes", IMPORT_SMALL_TARGET_BYTES);
  metric("import.largeTargetBytes", IMPORT_LARGE_TARGET_BYTES);
  metric("import.blockTargetPayloadBytes", config.capacity.inputs.historyBlockTargetPayloadBytes);
  metric("import.spoolSegmentBytes", config.spool.segmentBytes);

  forceGc();
  const before = noteMemory();
  metric("import.rssBeforeBytes", before.rssBytes);
  metric("import.heapUsedBeforeBytes", before.heapUsedBytes);

  await service.begin({
    scope: { organizationId: "org_sync_profile", rcsSessionId: "rcs_session_profile" },
    acpSessionId: "ses_profile_measure",
    owner: "profile-owner",
    leaseTtlMs: 600_000,
  });

  const sampler = startPeakSampler(MEMORY_SAMPLE_INTERVAL_MS);
  let payloadBytes = 0;
  let receiveMs = 0;
  let buildMs = 0;
  let finalizeMs = 0;
  let completed = false;
  let receiveFinished = false;

  try {
    const receiveStartedAt = performance.now();
    for (let index = 1; index <= smallObjects; index += 1) {
      const record = await service.accept(sizedHistoryObject(index, IMPORT_SMALL_TARGET_BYTES), {
        kind: "history_object",
        entryId: `entry-small-${index}`,
      } satisfies HistoryRecordMeta);
      payloadBytes += record.payloadBytes;
    }
    for (let index = 1; index <= largeObjects; index += 1) {
      const record = await service.accept(sizedHistoryObject(index, IMPORT_LARGE_TARGET_BYTES), {
        kind: "history_object",
        entryId: `entry-large-${index}`,
      } satisfies HistoryRecordMeta);
      payloadBytes += record.payloadBytes;
    }
    await service.receivingComplete();
    receiveMs = performance.now() - receiveStartedAt;
    receiveFinished = true;
    metric("import.receiveRssBytes", noteMemory().rssBytes);

    const buildStartedAt = performance.now();
    await service.buildAndCommit();
    buildMs = performance.now() - buildStartedAt;
    metric("import.buildRssBytes", noteMemory().rssBytes);

    const finalizeStartedAt = performance.now();
    await service.finalize();
    finalizeMs = performance.now() - finalizeStartedAt;
    completed = true;
  } finally {
    const status = service.status();
    const peak = sampler.stop();
    // 先 GC 再读「活工作集」：否则 after 读数里混着上一阶段尚未回收的垃圾。
    forceGc();
    reportImportOutcome({
      completed,
      state: status.state,
      failureCode: status.failure?.code ?? "none",
      objectCount: smallObjects + largeObjects,
      receivedOrdinal: status.receivedOrdinal,
      committedBlocks: status.committedBlocks,
      payloadBytes,
      receiveMs: receiveFinished ? receiveMs : 0,
      buildMs,
      finalizeMs,
      peak,
      beforeRssBytes: before.rssBytes,
      after: noteMemory(),
    });
  }
}

// ---------------------------------------------------------------- 3) 热工作集趋势

interface HotPoint {
  readonly appendedBytes: number;
  readonly loadedBytes: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly rssAfterGcBytes: number;
  readonly heapUsedAfterGcBytes: number;
}

/** 一个批次的观测点：先读未 GC 的现场，再强制 GC 读「活工作集」，两个数字都登记。 */
function sampleHotPoint(hub: DocHub, appendedBytes: number): HotPoint {
  const live = noteMemory();
  forceGc();
  const afterGc = noteMemory();
  return {
    appendedBytes,
    loadedBytes: hub.loadedBytes(),
    rssBytes: live.rssBytes,
    heapUsedBytes: live.heapUsedBytes,
    rssAfterGcBytes: afterGc.rssBytes,
    heapUsedAfterGcBytes: afterGc.heapUsedBytes,
  };
}

function reportHotPoint(prefix: string, batch: number, point: HotPoint): void {
  metric(`${prefix}.batch${batch}.appendedBytes`, point.appendedBytes);
  metric(`${prefix}.batch${batch}.loadedBytes`, point.loadedBytes);
  metric(`${prefix}.batch${batch}.rssBytes`, point.rssBytes);
  metric(`${prefix}.batch${batch}.heapUsedBytes`, point.heapUsedBytes);
  metric(`${prefix}.batch${batch}.rssAfterGcBytes`, point.rssAfterGcBytes);
  metric(`${prefix}.batch${batch}.heapUsedAfterGcBytes`, point.heapUsedAfterGcBytes);
}

/** 两个采样点（首批 vs 末批）的差值与「已加载字节/已追加字节」比值：热工作集是否线性增长的判据。 */
function reportHotTrend(prefix: string, points: readonly HotPoint[]): void {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    metric(`${prefix}.unavailable`, "no samples");
    return;
  }
  const appended = last.appendedBytes - first.appendedBytes;
  const loaded = last.loadedBytes - first.loadedBytes;
  metric(`${prefix}.batches`, points.length);
  metric(`${prefix}.appendedBytesBatch1ToLast`, appended);
  metric(`${prefix}.loadedBytesBatch1ToLast`, loaded);
  metric(`${prefix}.loadedPerAppendedByte`, appended === 0 ? Number.NaN : Number((loaded / appended).toFixed(4)));
  metric(`${prefix}.rssDeltaBatch1ToLastBytes`, last.rssBytes - first.rssBytes);
  metric(`${prefix}.rssAfterGcDeltaBatch1ToLastBytes`, last.rssAfterGcBytes - first.rssAfterGcBytes);
  metric(`${prefix}.heapUsedAfterGcDeltaBatch1ToLastBytes`, last.heapUsedAfterGcBytes - first.heapUsedAfterGcBytes);
}

/**
 * 口径 A：同一 Doc 连续追加（客户端在写）。这里的线性增长是**该 Doc 自身内容**的驻留估算，
 * 不是「已封存历史」——两者必须分开读，否则会把正常的在写增长误判成历史泄漏。
 */
async function measureHotSingleDoc(): Promise<void> {
  const harness = createMeasureHub();
  const docId = contentDocId(1, "nonce-hot-live");
  await primeBase(harness.hub, docId, "hotlive");
  const points: HotPoint[] = [];
  let appendedBytes = 0;
  let seq = 0;
  const startedAt = performance.now();
  for (let batch = 1; batch <= HOT_BATCHES; batch += 1) {
    const updates = buildStreamingUpdates(HOT_UPDATES_PER_BATCH, HOT_PAYLOAD_BYTES);
    const fed = await feedUpdates(harness.hub, docId, updates, seq, `hotlive${batch}`);
    seq = fed.lastSeq;
    appendedBytes += fed.appendedBytes;
    const point = sampleHotPoint(harness.hub, appendedBytes);
    points.push(point);
    reportHotPoint("hot.liveDoc", batch, point);
  }
  metric("hot.liveDoc.wallMs", toMs(performance.now() - startedAt));
  metric("hot.liveDoc.processedCount", harness.counts.processed);
  metric("hot.liveDoc.rejectedCount", harness.counts.rejected);
  reportHotTrend("hot.liveDoc", points);
  harness.dispose();
}

/**
 * 口径 B：每批写入一个新 Doc，写完即释放上一批 Doc（封存/退役副本不再驻留）。
 * 若 loadedBytes 与 RSS 在此口径下保持平台，则「热工作集不随已封存历史增长」在本机成立；
 * 若仍线性增长，说明释放路径没有真正回收，属缺陷。
 */
async function measureHotReleasedDocs(): Promise<void> {
  const harness = createMeasureHub();
  const docIds: string[] = [];
  const points: HotPoint[] = [];
  let appendedBytes = 0;
  const startedAt = performance.now();
  for (let batch = 1; batch <= HOT_BATCHES; batch += 1) {
    const docId = contentDocId(batch, `nonce-hot-sealed-${batch}`);
    docIds.push(docId);
    await primeBase(harness.hub, docId, `hotseal${batch}`);
    const updates = buildStreamingUpdates(HOT_UPDATES_PER_BATCH, HOT_PAYLOAD_BYTES);
    const fed = await feedUpdates(harness.hub, docId, updates, 0, `hotseal${batch}`);
    appendedBytes += fed.appendedBytes;
    // 释放上一批 Doc：引用计数归零即销毁实例（doc-hub 的 release 语义）。
    // 只释放紧邻的上一个——更早的批次在前几轮已经释放，重复 release 会命中「无配对 retain」的错误路径。
    const previousDocId = docIds[batch - 2];
    if (previousDocId !== undefined) {
      harness.hub.release(previousDocId);
    }
    const point = sampleHotPoint(harness.hub, appendedBytes);
    points.push(point);
    reportHotPoint("hot.releasedDocs", batch, point);
  }
  const lastDocId = docIds[docIds.length - 1];
  if (lastDocId !== undefined) {
    harness.hub.release(lastDocId);
  }
  metric("hot.releasedDocs.wallMs", toMs(performance.now() - startedAt));
  metric("hot.releasedDocs.processedCount", harness.counts.processed);
  metric("hot.releasedDocs.rejectedCount", harness.counts.rejected);
  metric("hot.releasedDocs.loadedBytesAfterAllReleased", harness.hub.loadedBytes());
  reportHotTrend("hot.releasedDocs", points);
  harness.dispose();
}

async function measureHotWorkingSet(): Promise<void> {
  section("hot-working-set（5 批 × 2000 条 × 1KiB，口径 A=同 Doc 持续追加 / 口径 B=旧 Doc 释放后）");
  metric("hot.updatesPerBatch", HOT_UPDATES_PER_BATCH);
  metric("hot.payloadTargetBytes", HOT_PAYLOAD_BYTES);
  forceGc();
  metric("hot.rssBeforeBytes", noteMemory().rssBytes);
  await measureHotSingleDoc();
  forceGc();
  metric("hot.rssBeforeReleasedDocsBytes", noteMemory().rssBytes);
  await measureHotReleasedDocs();
}

// ---------------------------------------------------------------- 主流程

/** 单个分区失败不掩盖全局：打印原因并继续（不编造数字，也不把失败改写成通过）。 */
async function runSection(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    metric(`${name}.unavailable`, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  console.log("# sync runtime profile measurement (本机短时采样；不是设计 §15.3 的固定 profile)");
  section("environment");
  reportEnvironment();
  const baseline = noteMemory();
  metric("env.baselineRssBytes", baseline.rssBytes);
  metric("env.baselineHeapUsedBytes", baseline.heapUsedBytes);

  forceGc();
  await runSection("apply", measureApplyLatency);
  forceGc();

  // 暂存目录是本脚本唯一的磁盘写入点：系统临时目录（`tmpdir()`，不读进程环境），结束整体删除。
  await runSection("import", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "sync-profile-measure-"));
    try {
      await measureHistoryImport(
        tempRoot,
        objectCountOverride("small", IMPORT_SMALL_OBJECTS),
        objectCountOverride("large", IMPORT_LARGE_OBJECTS),
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
  forceGc();

  await runSection("hot", measureHotWorkingSet);

  section("process-peak");
  metric("profile.processPeakRssBytes", peakRssBytes);
  metric("profile.processPeakRssMiB", toMib(peakRssBytes));
  metric("profile.processPeakHeapUsedBytes", peakHeapUsedBytes);
  metric("profile.processPeakHeapUsedMiB", toMib(peakHeapUsedBytes));
  metric("profile.endRssBytes", noteMemory().rssBytes);
}

await main();
