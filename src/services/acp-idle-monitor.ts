// ────────────────────────────────────────────
// 编排域重构保留说明（I4：旧代码删除与精简）
// ────────────────────────────────────────────
// 此文件保留：非交互式实例的空闲回收机制仍依赖它（routes/web/instances 的监控视图、
// src/index.ts 的定时器启停）。Chat 交互实例不再因 idle/activity 自动停止，但
// scheduled / system 实例仍需要回收出口，避免后台任务长期泄漏。
import type { RuntimeInstanceSnapshot } from "@fenix/core";
import { createLogger } from "@fenix/logger";
import { config } from "../config";
import { findUsersBasicInfoByIds } from "../repositories";
import { isActiveRuntimeStatus } from "./agent-concurrency";
import { getCoreRuntime } from "./core-bootstrap";
import { docManager } from "./doc-manager-instance";
import { getInstance, type InstanceActivityInfo, stopInstance, toInstanceActivityInfo } from "./instance";
import { globalInstanceRegistry } from "./instance-registry";

const logger = createLogger("acp-idle-monitor");

let sweepTimer: ReturnType<typeof setInterval> | null = null;

const _deps = {
  getCoreRuntime,
  getInstance,
  stopInstance,
};
const _defaultDeps = { ..._deps };

/** 测试用：覆盖内部依赖，避免 mock.module。 */
export function setAcpIdleMonitorDeps(overrides: Partial<typeof _deps>): void {
  Object.assign(_deps, overrides);
}

/** 测试用：恢复默认依赖。 */
export function resetAcpIdleMonitorDeps(): void {
  Object.assign(_deps, _defaultDeps);
}

function isIgnoredActivityMessageType(type: string | undefined): boolean {
  return type === "keep_alive" || type === "heartbeat" || type === "ping" || type === "pong";
}

/** 判断一条消息是否应计入实例业务活跃度。 */
export function shouldCountInstanceActivity(message: Record<string, unknown>): boolean {
  if ((message.jsonrpc as string | undefined) === "2.0") return true;
  return !isIgnoredActivityMessageType(message.type as string | undefined);
}

/** 记录实例业务活跃时间，仅统计非保活类 ACP 消息。 */
export function touchInstanceActivity(instanceId: string, message: Record<string, unknown>, at = Date.now()): void {
  if (!shouldCountInstanceActivity(message)) return;
  globalInstanceRegistry.touchActivity(instanceId, at);
}

/** 记录 relay 已绑定到实例，表示实例重新进入前台使用状态。 */
export function markInstanceRelayAttached(instanceId: string, at = Date.now()): void {
  globalInstanceRegistry.attachRelay(instanceId, at);
}

/** 记录 relay 已从实例断开，开始空闲观察窗口。 */
export function markInstanceRelayDetached(instanceId: string, at = Date.now()): void {
  globalInstanceRegistry.detachRelay(instanceId, at);
}

function toFallbackActivityInfo(snapshot: RuntimeInstanceSnapshot): InstanceActivityInfo {
  const meta = snapshot.pluginMetadata ?? {};
  const createdAtSeconds = Math.floor(snapshot.createdAt.getTime() / 1000);
  return {
    id: snapshot.instanceId,
    port: typeof meta.port === "number" ? meta.port : 0,
    status: snapshot.status === "running" || snapshot.status === "error" ? snapshot.status : "starting",
    error: snapshot.errorMessage ?? null,
    group_id: "",
    environment_id: null,
    session_id: null,
    instance_number: 0,
    created_at: createdAtSeconds,
    user: null,
    spawn_source: null,
    // 缺少 supplement 时无法可靠推导活动信息；这里保守给默认值，
    // 仅用于"统计所有实例"场景，避免 runtime 活跃实例被整体漏掉。
    last_activity_at: createdAtSeconds,
    relay_count: 0,
    last_relay_detached_at: null,
    idle_seconds: 0,
    idle_timeout_seconds: config.acpIdleTimeoutSeconds,
    idle_kill_eligible: false,
    inactivity_seconds: 0,
    activity_timeout_seconds: config.acpActivityTimeoutSeconds,
    activity_kill_eligible: false,
  };
}

function shouldIncludeSnapshot(snapshot: RuntimeInstanceSnapshot, showError: boolean): boolean {
  return showError
    ? isActiveRuntimeStatus(snapshot.status) || snapshot.status === "error"
    : isActiveRuntimeStatus(snapshot.status);
}

/** 返回当前所有活跃实例的 ACP 空闲观测视图。 */
export function listInstanceActivitySnapshots(
  now = Date.now(),
  organizationId?: string,
  showError = false,
): InstanceActivityInfo[] {
  const runtime = _deps.getCoreRuntime();
  const instances = runtime.listInstances();
  const results: InstanceActivityInfo[] = [];
  for (const snapshot of instances) {
    if (!shouldIncludeSnapshot(snapshot, showError)) continue;
    const supplement = globalInstanceRegistry.get(snapshot.instanceId);
    if (!supplement) {
      if (organizationId) {
        // 没有 supplement 时无法判断组织归属，因此在指定组织 ID 时直接跳过该实例。
        continue;
      } else {
        // 没有 supplement 时无法可靠推导活动信息；这里保守给默认值，
        // 仅用于"统计所有实例"场景，避免 runtime 活跃实例被整体漏掉。
        results.push(toFallbackActivityInfo(snapshot));
        continue;
      }
    }
    if (organizationId && supplement.organizationId !== organizationId) continue;

    const instance = _deps.getInstance(snapshot.instanceId);
    if (!instance) continue;
    results.push(
      toInstanceActivityInfo(instance, supplement, config.acpIdleTimeoutSeconds, config.acpActivityTimeoutSeconds, now),
    );
  }
  return results.sort((a, b) => b.idle_seconds - a.idle_seconds);
}

/** 为实例活动快照补齐用户展示信息，方便管理侧识别占用者。 */
export async function listInstanceActivitySnapshotsWithUsers(
  now = Date.now(),
  organizationId?: string,
  showError = false,
): Promise<InstanceActivityInfo[]> {
  const snapshots = listInstanceActivitySnapshots(now, organizationId, showError);
  const userIds = [...new Set(snapshots.flatMap((snapshot) => (snapshot.user?.id ? [snapshot.user.id] : [])))];
  if (userIds.length === 0) {
    return snapshots;
  }

  const userRows = await findUsersBasicInfoByIds(userIds);
  const userMap = new Map(userRows.map((row) => [row.id, row]));

  return snapshots.map((snapshot) => {
    if (!snapshot.user) {
      return snapshot;
    }
    const userRow = userMap.get(snapshot.user.id);
    return {
      ...snapshot,
      user: {
        id: snapshot.user.id,
        name: userRow?.name ?? null,
        email: userRow?.email ?? null,
      },
    };
  });
}

/** 关闭前端 relay 并停止满足回收条件的实例。 */
async function reclaimInstance(
  snapshot: InstanceActivityInfo,
  supplement: NonNullable<ReturnType<typeof globalInstanceRegistry.get>>,
  reason: "inactive" | "idle",
): Promise<void> {
  const { closeRelayConnectionsForIdleReclaim } = await import("../transport/relay");
  closeRelayConnectionsForIdleReclaim(snapshot.id);

  const result = await _deps.stopInstance(snapshot.id, supplement.organizationId);
  if (!result.ok && result.error !== "Already stopped" && result.error !== "Instance not found") {
    logger.error(
      `[ACP-IDLE] Failed to stop ${reason} instance id=${snapshot.id} env=${snapshot.environment_id ?? ""}: ${result.error}`,
    );
  }
}

/** 扫描实例；满足空闲超时或业务无活动硬超时条件时自动停止实例。 */
export async function runAcpIdleMonitorSweep(now = Date.now()): Promise<void> {
  // SP-C2 观测信号：周期输出内存实时 Doc 数量，供长期采集"实例回收 → Doc 回收"
  // 是否生效的曲线（只含数量，不含会话 ID / 内容）。实例停止后的 Doc 回收接线在
  // stopInstanceViaController 完成处（orchestration-instance）。
  const docCount = docManager.openedDocCount();
  logger.info(`[ACP-IDLE] yjs realtime docs: chat=${docCount.chat} session=${docCount.session}`);

  const idleTimeoutMs = config.acpIdleTimeoutSeconds * 1000;
  const activityTimeoutMs = config.acpActivityTimeoutSeconds * 1000;
  const snapshots = listInstanceActivitySnapshots(now);
  for (const snapshot of snapshots) {
    const supplement = globalInstanceRegistry.get(snapshot.id);
    if (!supplement) continue;
    // Chat interactive 实例的连接和 Agent 进程由用户显式停止或正常连接关闭管理；
    // 不再基于业务静默或 relay 缺失回收，确保长期打开的会话不会被服务端主动断链。
    // 非交互式 scheduled / system 实例继续采用既有 idle/activity 回收策略。
    if (supplement.spawnSource === "interactive") continue;

    // activity 回收与 relay 是否存在无关：后台任务长时间无业务消息（卡死、失去响应、
    // relay 状态异常）时，仍按硬超时回收，避免实例因 relay_count 永不归零而失去自动回收出口。
    const inactiveTooLong = now - supplement.lastActivityAt >= activityTimeoutMs;
    if (inactiveTooLong) {
      logger.info(
        `[ACP-IDLE] Stopping inactive instance id=${snapshot.id} env=${snapshot.environment_id ?? ""} inactivity=${snapshot.inactivity_seconds}s timeout=${config.acpActivityTimeoutSeconds}s relayCount=${snapshot.relay_count}`,
      );
      try {
        await reclaimInstance(snapshot, supplement, "inactive");
      } catch (err) {
        logger.error(`[ACP-IDLE] reclaimInstance failed for ${snapshot.id}:`, err instanceof Error ? err : undefined);
      }
      continue;
    }

    // 只有无前端 relay 时才按 idle 回收：relay_count > 0 只阻止 idle 回收，
    // 不能阻止 activity 回收（见上方判断）。
    if (snapshot.relay_count > 0) continue;

    const idleSince = Math.max(supplement.lastActivityAt, supplement.lastRelayDetachedAt ?? 0);
    if (now - idleSince < idleTimeoutMs) continue;

    logger.info(
      `[ACP-IDLE] Stopping idle instance id=${snapshot.id} env=${snapshot.environment_id ?? ""} idle=${snapshot.idle_seconds}s timeout=${config.acpIdleTimeoutSeconds}s`,
    );
    try {
      await reclaimInstance(snapshot, supplement, "idle");
    } catch (err) {
      logger.error(`[ACP-IDLE] reclaimInstance failed for ${snapshot.id}:`, err instanceof Error ? err : undefined);
    }
  }
}

/** 启动 ACP 空闲巡检定时器。 */
export function startAcpIdleMonitor(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runAcpIdleMonitorSweep().catch((err) => {
      logger.error("[ACP-IDLE] Sweep failed", err instanceof Error ? err : undefined);
    });
  }, config.acpIdleSweepIntervalSeconds * 1000);
}

/** 停止 ACP 空闲巡检定时器。 */
export function stopAcpIdleMonitor(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
