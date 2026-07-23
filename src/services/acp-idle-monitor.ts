import type { RuntimeInstanceSnapshot } from "@fenix/core";
import { createLogger } from "@fenix/logger";
import { config } from "../config";
import { getCoreRuntime } from "./core-bootstrap";
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
    status: snapshot.status === "running" ? "running" : "starting",
    error: snapshot.errorMessage ?? null,
    group_id: "",
    environment_id: null,
    session_id: null,
    instance_number: 0,
    created_at: createdAtSeconds,
    // 缺少 supplement 时无法可靠推导活动信息；这里保守给默认值，
    // 仅用于“统计所有实例”场景，避免 runtime 活跃实例被整体漏掉。
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

/** 返回当前所有活跃实例的 ACP 空闲观测视图。 */
export function listInstanceActivitySnapshots(now = Date.now(), organizationId?: string): InstanceActivityInfo[] {
  const runtime = _deps.getCoreRuntime();
  const instances = runtime.listInstances();
  const results: InstanceActivityInfo[] = [];
  for (const snapshot of instances) {
    if (snapshot.status === "stopped" || snapshot.status === "stopping") continue;
    const supplement = globalInstanceRegistry.get(snapshot.instanceId);
    if (!supplement) {
      if (organizationId) {
        // 没有 supplement 时无法判断组织归属，因此在指定组织 ID 时直接跳过该实例。
        continue;
      } else {
        // 没有 supplement 时无法可靠推导活动信息；这里保守给默认值，
        // 仅用于“统计所有实例”场景，避免 runtime 活跃实例被整体漏掉。
        results.push(toFallbackActivityInfo(snapshot));
        continue;
      }
    }
    if (organizationId && supplement.organizationId !== organizationId) continue;
    const instance = _deps.getInstance(snapshot.instanceId, supplement.userId);
    if (!instance) continue;
    results.push(
      toInstanceActivityInfo(instance, supplement, config.acpIdleTimeoutSeconds, config.acpActivityTimeoutSeconds, now),
    );
  }
  return results.sort((a, b) => b.idle_seconds - a.idle_seconds);
}

/** 扫描实例；满足空闲超时或业务无活动硬超时条件时自动停止实例。 */
export async function runAcpIdleMonitorSweep(now = Date.now()): Promise<void> {
  const idleTimeoutMs = config.acpIdleTimeoutSeconds * 1000;
  const activityTimeoutMs = config.acpActivityTimeoutSeconds * 1000;
  const snapshots = listInstanceActivitySnapshots(now);
  for (const snapshot of snapshots) {
    const supplement = globalInstanceRegistry.get(snapshot.id);
    if (!supplement) continue;
    const inactiveTooLong = now - supplement.lastActivityAt >= activityTimeoutMs;
    if (inactiveTooLong) {
      logger.info(
        `[ACP-IDLE] Stopping inactive instance id=${snapshot.id} env=${snapshot.environment_id ?? ""} inactivity=${snapshot.inactivity_seconds}s timeout=${config.acpActivityTimeoutSeconds}s relayCount=${snapshot.relay_count}`,
      );
      const result = await _deps.stopInstance(snapshot.id, supplement.organizationId);
      if (!result.ok && result.error !== "Already stopped" && result.error !== "Instance not found") {
        logger.error(
          `[ACP-IDLE] Failed to stop inactive instance id=${snapshot.id} env=${snapshot.environment_id ?? ""}: ${result.error}`,
        );
      }
      continue;
    }

    if (snapshot.relay_count > 0) continue;
    const idleSince = Math.max(supplement.lastActivityAt, supplement.lastRelayDetachedAt ?? 0);
    if (now - idleSince < idleTimeoutMs) continue;

    logger.info(
      `[ACP-IDLE] Stopping idle instance id=${snapshot.id} env=${snapshot.environment_id ?? ""} idle=${snapshot.idle_seconds}s timeout=${config.acpIdleTimeoutSeconds}s`,
    );
    const result = await _deps.stopInstance(snapshot.id, supplement.organizationId);
    if (!result.ok && result.error !== "Already stopped" && result.error !== "Instance not found") {
      logger.error(
        `[ACP-IDLE] Failed to stop idle instance id=${snapshot.id} env=${snapshot.environment_id ?? ""}: ${result.error}`,
      );
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
