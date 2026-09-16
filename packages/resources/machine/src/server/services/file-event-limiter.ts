// file-event-limiter.ts — 文件变更事件限频与批量合并器（docs/arch/12-files.md §4.3 / §7.5）
//
// 职责：本地写路径（agent-file-service）与机器端 file_changed 帧（file-ws-handler）
// 的统一发布入口。超限事件合并为 file_changed_batch（≤50 条路径，增量语义），
// 不是 invalidate_all —— 修复 D20 语义倒挂（50 条轻事件绝不应退化为整树重拉）。
// 发布目标为 W4a 的 file-event-queue（异步、按环境 fan-out、溢出收敛 invalidate_all）。
//
// 限频规则（§4.3 / §7.5）：
// - 环境级：20 条/s；机器级（提供 machineId 时）：100 条/s；任一超限 → 并入 batch。
// - invalidate_all / degraded：合并限频 1 条/30s/environment（超限直接合并丢弃，
//   订阅方 30s coalescing 与服务端侧限频语义一致，避免失效帧风暴）。
// - 窗口为固定 1s 时间桶；now 参数供测试注入，生产不传（与
//   file-ws-handler.sweepFileWsConnections 的 now 注入模式一致）。

import type { FileBatchChange, FileChangeKind, FileChangeSource } from "./file-event-queue";
import { publishFileEvent, publishInvalidateAll } from "./file-event-queue";

export type { FileChangeKind, FileChangeSource };

/** 单条变更输入（发布侧）：actorId/to 为可选审计/rename 目标字段 */
export interface FileChangeEvent {
  path: string;
  kind: FileChangeKind;
  source: FileChangeSource;
  actorId?: string;
  to?: string;
}

/** 环境级限频：20 条/s（§4.3） */
const ENV_RATE_LIMIT = 20;
/** 机器级限频：100 条/s（§4.3） */
const MACHINE_RATE_LIMIT = 100;
/** 限频窗口长度（固定 1s 时间桶） */
const RATE_WINDOW_MS = 1_000;
/** batch 单帧上限：≤50 条路径（增量语义，不是 invalidate_all — D20） */
const BATCH_MAX_CHANGES = 50;
/** 末条入批后的延迟 flush：聚合同窗口突发，避免每条超限事件都发一帧 */
const BATCH_FLUSH_DELAY_MS = 250;
/** invalidate_all / degraded 合并限频：1 条/30s/environment */
const RARE_EVENT_WINDOW_MS = 30_000;

interface RateWindow {
  start: number;
  count: number;
}

/** 环境级限频窗口表（key：environmentId） */
const envRate = new Map<string, RateWindow>();
/** 机器级限频窗口表（key：machineId） */
const machineRate = new Map<string, RateWindow>();
/** 环境级 batch 缓冲（key：environmentId；含延迟 flush 定时器） */
const envBatches = new Map<string, { changes: FileBatchChange[]; timer: ReturnType<typeof setTimeout> | null }>();
/** 罕见帧（invalidate_all / degraded）最近发送时间（key：`inv:${envId}` / `deg:${envId}`） */
const rareSentAt = new Map<string, number>();

/**
 * 检查固定窗口限频：窗口内未超限 → 计数并放行；超限 → 拒绝。
 * 窗口过期自动重置（惰性，key 保留但值被新窗口覆盖，活跃 key 数有界于环境/机器数）。
 */
function checkRate(map: Map<string, RateWindow>, key: string, limit: number, now: number): boolean {
  const window = map.get(key);
  if (!window || now - window.start >= RATE_WINDOW_MS) {
    map.set(key, { start: now, count: 1 });
    return true;
  }
  if (window.count >= limit) {
    return false;
  }
  window.count++;
  return true;
}

/** 将一条超限事件并入该环境 batch；满 BATCH_MAX_CHANGES 立即 flush，否则延迟 flush */
function enqueueBatch(envId: string, change: FileBatchChange): void {
  let batch = envBatches.get(envId);
  if (!batch) {
    batch = { changes: [], timer: null };
    envBatches.set(envId, batch);
  }
  batch.changes.push(change);
  if (batch.changes.length >= BATCH_MAX_CHANGES) {
    flushBatch(envId, batch);
    return;
  }
  if (!batch.timer) {
    batch.timer = setTimeout(() => flushBatch(envId, batch), BATCH_FLUSH_DELAY_MS);
  }
}

/** flush 该环境 batch 为 file_changed_batch 帧；flush 期间新入批的条目留待下个定时器 */
function flushBatch(
  envId: string,
  batch: { changes: FileBatchChange[]; timer: ReturnType<typeof setTimeout> | null },
): void {
  if (batch.timer) {
    clearTimeout(batch.timer);
    batch.timer = null;
  }
  const changes = batch.changes;
  batch.changes = [];
  if (changes.length > 0) {
    publishFileEvent(envId, { type: "file_changed_batch", changes });
  }
  if (batch.changes.length === 0) {
    envBatches.delete(envId);
  }
}

/**
 * 立即 flush 指定环境的 pending batch（无参 flush 全部）。
 * 测试注入点：消除 250ms 延迟定时器在全量并发负载下的时序依赖（flaky 根治）；
 * 生产代码仅在优雅关闭路径可用，正常流程仍由定时器延迟 flush 聚合同窗口突发。
 */
export function flushPendingBatches(envId?: string): void {
  if (envId) {
    const batch = envBatches.get(envId);
    if (batch) flushBatch(envId, batch);
    return;
  }
  for (const [id, batch] of envBatches) {
    flushBatch(id, batch);
  }
}

/**
 * 发布单条文件变更（本地写路径与机器端 file_changed 帧统一入口，不得跳过）。
 *
 * 环境级限频 20 条/s；opts.machineId 提供时叠加机器级限频 100 条/s。
 * 任一超限 → 事件并入该环境 batch（增量合并，≤50 条），由延迟定时器 flush。
 * 发布为异步（入队即返回），慢订阅者不阻塞调用方。
 */
export function publishFileChanged(
  envId: string,
  change: FileChangeEvent,
  opts?: { machineId?: string },
  now: number = Date.now(),
): void {
  const envAllowed = checkRate(envRate, envId, ENV_RATE_LIMIT, now);
  const machineAllowed = opts?.machineId ? checkRate(machineRate, opts.machineId, MACHINE_RATE_LIMIT, now) : true;
  if (envAllowed && machineAllowed) {
    publishFileEvent(envId, {
      type: "file_changed",
      path: change.path,
      kind: change.kind,
      source: change.source,
      actor_id: change.actorId,
      to: change.to,
    });
    return;
  }
  enqueueBatch(envId, { path: change.path, kind: change.kind, source: change.source, actor_id: change.actorId });
}

/**
 * 发布全量失效帧（仅未知范围：机器重连、path 未知的外部变更）。
 * 合并限频 1 条/30s/environment：窗口内重复失效帧直接合并丢弃
 * （订阅方 coalescing 与之一致，服务端提前收敛避免失效风暴）。
 */
export function publishInvalidateAllLimited(envId: string, now: number = Date.now()): void {
  const key = `inv:${envId}`;
  const lastSentAt = rareSentAt.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now - lastSentAt < RARE_EVENT_WINDOW_MS) {
    return;
  }
  rareSentAt.set(key, now);
  publishInvalidateAll(envId);
}

/**
 * 发布能力降级帧（机器级事件，按环境路由下发）。
 * 与 invalidate_all 共用罕见帧限频：1 条/30s/environment。
 */
export function publishDegradedLimited(
  envId: string,
  machineId: string,
  status: "down" | "recovered",
  now: number = Date.now(),
): void {
  const key = `deg:${envId}`;
  const lastSentAt = rareSentAt.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now - lastSentAt < RARE_EVENT_WINDOW_MS) {
    return;
  }
  rareSentAt.set(key, now);
  publishFileEvent(envId, { type: "degraded", machine_id: machineId, capability: "file", status });
}
