// ────────────────────────────────────────────
// 编排域重构保留说明（I4：旧代码删除与精简）
// ────────────────────────────────────────────
// 实例生命周期（启动/停止）已统一收敛到编排域：启动走 orchestration-instance 的
// spawnInstanceViaController（controller.spawnInstance 环境校验/节点获取 →
// core launchInstance → registerSupplement），并发配额统一由宿主 agent-concurrency
// reservation 在进入 controller 前治理；停止走 stopInstanceViaController
// （活跃表移除 + 节点引用归还 → core 停止 → supplement 清理）。本文件不再承载
// 启动/停止的完整实现，仅保留：
//   1. RCS 业务查询层（listInstances / getInstance / findRunningInstanceByEnvironment
//      等，读 core 运行时快照 + globalInstanceRegistry supplement）；
//   2. ensureRunning / enterEnvironment 的会话语义（复用运行实例、autoStart，
//      spawn 分支委托编排域入口）；
//   3. stopInstance / stopAllInstances 作为编排域停止入口的薄委托层，保留组织归属
//      校验与"已停止幂等"语义，供 web DELETE / acp-idle-monitor / graceful shutdown 使用。
// 旧 spawnInstanceFromEnvironment / findInstanceBySessionId / SpawnInstanceOptions
// 已在休克疗法中删除，不再恢复。
import type { RuntimeInstanceSnapshot } from "@fenix/core";
import { error as logError } from "@fenix/logger";
import {
  hasActiveAgentExecutions,
  hasOnlyConfirmedScheduledExecutions,
  isAgentExecutionIdleReclaimable,
} from "../../services/agent-execution-admission";
import { globalInstanceRegistry } from "../../services/instance-registry";
import { getOrchestrationController } from "../../services/orchestration-bootstrap";
import type { InstanceSpawnSource, InstanceSupplement } from "../../types/instance";
import { getAgentRuntimeConfig } from "../config";
import { agentInstanceRuntimeCoordinator } from "./agent-instance-service";
import { getBoundCoreRuntime as getCoreRuntime } from "./core-runtime-port";

// ────────────────────────────────────────────
// 公共类型
// ────────────────────────────────────────────

export interface SpawnedInstance {
  id: string;
  userId: string;
  port: number;
  pid: number | null;
  status: "starting" | "running" | "stopped" | "error";
  command: string;
  error: string | null;
  apiKey: string;
  createdAt: Date;
  environmentId?: string;
  sessionId?: string;
}

/** 自动回收原因：硬超时可以终止挂死的定时执行，普通空闲回收始终尊重执行租约。 */
export type InstanceReclaimReason = "idle" | "activity-timeout";

/** 对外 `/web/instances/*` API 使用的实例详情结构。 */
export interface InstanceInfo {
  id: string;
  port: number;
  status: "starting" | "running" | "stopped" | "error";
  error: string | null;
  group_id: string;
  environment_id: string | null;
  session_id: string | null;
  created_at: number;
}

/**
 * toInstanceInfo 的输入视图：兼容旧路径 SpawnedInstance（id 字段）与编排域
 * Instance（instanceId 字段 + status() 方法）。编排域 Instance 数据面不携带
 * port/error/createdAt 等展示字段，由 toInstanceInfo 实现从
 * core 运行时快照与 RCS supplement 补全，仍缺失时兜底默认值。
 */
export interface InstanceInfoSource {
  id?: string;
  instanceId?: string;
  environmentId?: string;
  status?: InstanceInfo["status"] | (() => InstanceInfo["status"]);
  port?: number;
  error?: string | null;
  sessionId?: string;
  createdAt?: Date;
}

export interface InstanceActivityInfo extends InstanceInfo {
  user: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  spawn_source: InstanceSpawnSource | null;
  last_activity_at: number;
  relay_count: number;
  last_relay_detached_at: number | null;
  idle_seconds: number;
  idle_timeout_seconds: number;
  idle_kill_eligible: boolean;
  inactivity_seconds: number;
  activity_timeout_seconds: number;
  activity_kill_eligible: boolean;
}

export interface EnsureRunningResult {
  instance: SpawnedInstance;
  status: "reused" | "spawned";
}

// ────────────────────────────────────────────
// 实例注册表：封装 core 不维护的 RCS 业务字段
// ────────────────────────────────────────────

const registry = globalInstanceRegistry;

function mapCoreStatus(status: import("@fenix/core").RuntimeInstanceStatus): SpawnedInstance["status"] {
  switch (status) {
    case "running":
      return "running";
    case "stopped":
    case "stopping":
      return "stopped";
    case "error":
      return "error";
    default:
      return "starting";
  }
}

/**
 * 从 core snapshot 的 pluginMetadata 中读取 port/token/pid，
 * 合并 supplement 中的 RCS 业务字段，生成前端兼容的 SpawnedInstance。
 */
function toSpawnedInstance(snapshot: RuntimeInstanceSnapshot, supplement: InstanceSupplement): SpawnedInstance {
  const meta = snapshot.pluginMetadata ?? {};
  return {
    id: snapshot.instanceId,
    userId: supplement.userId,
    port: typeof meta.port === "number" ? meta.port : 0,
    pid: typeof meta.pid === "number" ? meta.pid : null,
    status: mapCoreStatus(snapshot.status),
    command: "",
    error: snapshot.errorMessage ?? null,
    apiKey: typeof meta.token === "string" ? meta.token : "",
    createdAt: snapshot.createdAt,
    environmentId: supplement.environmentId,
    sessionId: undefined,
  };
}

/**
 * 将内部实例对象转换为对外 API 契约。
 *
 * 这里保留 snake_case，避免路由层直接暴露内部 camelCase 结构，
 * 否则会和 Elysia 的 response schema 校验发生偏差。
 *
 * 输入兼容两类来源：
 *   1. SpawnedInstance（旧路径实例，字段完整）；
 *   2. 编排域 Instance 的最小视图（仅 instanceId + environmentId + status()），
 *      其 port/error/createdAt 由实现从 core 运行时快照与
 *      RCS supplement 补全，两者都缺失时（如启动回滚竞态）兜底默认值。
 */
export function toInstanceInfo(instance: SpawnedInstance | InstanceInfoSource): InstanceInfo {
  // 编排域 Instance 仅有 instanceId（无 id），SpawnedInstance 仅有 id；
  // 两者都存在时优先 instanceId（编排域路径的权威标识）。
  const instanceId = "instanceId" in instance ? instance.instanceId : undefined;
  const id = instanceId ?? instance.id ?? "";
  const environmentId = instance.environmentId ?? null;
  const status = typeof instance.status === "function" ? instance.status() : (instance.status ?? "starting");

  let port = instance.port ?? 0;
  let error = instance.error ?? null;
  const sessionId = instance.sessionId ?? null;
  let createdAt = instance.createdAt;

  // 编排域 Instance 分支（仅 instanceId、无 id 字段）：core 快照补 port/error/createdAt，
  if (instanceId !== undefined && instance.id === undefined) {
    const snapshot = getCoreRuntime()
      .listInstances()
      .find((s) => s.instanceId === instanceId);
    if (snapshot) {
      const meta = snapshot.pluginMetadata ?? {};
      port = typeof meta.port === "number" ? meta.port : 0;
      error = snapshot.errorMessage ?? null;
      createdAt = snapshot.createdAt;
    }
    const sup = registry.get(instanceId);
    if (sup) {
    }
  }

  return {
    id,
    port,
    status,
    error,
    // 现有 API 契约要求 group_id 必填；当前实例域里没有独立 group 概念，
    // 这里沿用 environmentId 作为兼容值，后续若拆分语义需同步调整 schema 与客户端。
    group_id: environmentId ?? "",
    environment_id: environmentId,
    session_id: sessionId,
    created_at: createdAt ? Math.floor(createdAt.getTime() / 1000) : 0,
  };
}

/** 监控视图与回收执行共用策略，活跃执行优先于实例来源或历史启动来源。 */
export function canAutomaticallyReclaimInstance(instanceId: string, supplement: InstanceSupplement): boolean {
  return (
    !hasActiveAgentExecutions(instanceId) &&
    (supplement.spawnSource !== "interactive" || isAgentExecutionIdleReclaimable(instanceId))
  );
}

/** 活动硬期限允许停止挂死定时执行，不能接管交互执行或正在等待启动的执行。 */
export function canReclaimInstanceForActivityTimeout(instanceId: string, supplement: InstanceSupplement): boolean {
  return canAutomaticallyReclaimInstance(instanceId, supplement) || hasOnlyConfirmedScheduledExecutions(instanceId);
}

/** 将实例与 registry 中的空闲观测状态组装为监控视图。 */
export function toInstanceActivityInfo(
  instance: SpawnedInstance,
  supplement: InstanceSupplement,
  idleTimeoutSeconds: number,
  activityTimeoutSeconds: number,
  now = Date.now(),
): InstanceActivityInfo {
  const idleSince = Math.max(supplement.lastActivityAt, supplement.lastRelayDetachedAt ?? 0);
  const idleSeconds = supplement.relayCount === 0 ? Math.max(0, Math.floor((now - idleSince) / 1000)) : 0;
  const inactivitySeconds = Math.max(0, Math.floor((now - supplement.lastActivityAt) / 1000));
  const automaticReclaimEnabled = canAutomaticallyReclaimInstance(instance.id, supplement);
  return {
    ...toInstanceInfo(instance),
    user: {
      id: supplement.userId,
      name: null,
      email: null,
    },
    spawn_source: supplement.spawnSource,
    last_activity_at: Math.floor(supplement.lastActivityAt / 1000),
    relay_count: supplement.relayCount,
    last_relay_detached_at:
      supplement.lastRelayDetachedAt === null ? null : Math.floor(supplement.lastRelayDetachedAt / 1000),
    idle_seconds: idleSeconds,
    idle_timeout_seconds: idleTimeoutSeconds,
    idle_kill_eligible: automaticReclaimEnabled && supplement.relayCount === 0 && idleSeconds >= idleTimeoutSeconds,
    inactivity_seconds: inactivitySeconds,
    activity_timeout_seconds: activityTimeoutSeconds,
    activity_kill_eligible:
      canReclaimInstanceForActivityTimeout(instance.id, supplement) && inactivitySeconds >= activityTimeoutSeconds,
  };
}

// ────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────

/** 统一的实例查询+转换：按 filter 条件筛选，再转为 SpawnedInstance */
function filterInstances(
  predicate: (snapshot: RuntimeInstanceSnapshot, sup: InstanceSupplement) => boolean,
): SpawnedInstance[] {
  const facade = getCoreRuntime();
  return facade.listInstances().flatMap((s) => {
    const sup = registry.get(s.instanceId);
    if (!sup) return [];
    if (!predicate(s, sup)) return [];
    return [toSpawnedInstance(s, sup)];
  });
}

/** 按 organizationId 过滤实例 */
function filterInstancesWithTeamId(organizationId: string): SpawnedInstance[] {
  return filterInstances((_s, sup) => sup.organizationId === organizationId);
}

export function listInstances(organizationId: string): SpawnedInstance[] {
  return filterInstancesWithTeamId(organizationId);
}

export function findRunningInstanceByEnvironment(environmentId: string, userId?: string): SpawnedInstance | undefined {
  const results = filterInstances(
    (s, sup) => sup.environmentId === environmentId && s.status === "running" && (!userId || sup.userId === userId),
  );
  return results[0];
}

export function listInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  return filterInstances(
    (s, sup) => sup.environmentId === environmentId && s.status !== "stopped" && s.status !== "error",
  );
}

export function getRunningInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  return filterInstances((s, sup) => sup.environmentId === environmentId && s.status === "running");
}

/** 一次遍历：按 environmentId 分组所有活跃实例，避免 N 次 listInstances 调用 */
export function groupActiveInstancesByEnvironment(): Map<string, SpawnedInstance[]> {
  const facade = getCoreRuntime();
  const result = new Map<string, SpawnedInstance[]>();
  for (const s of facade.listInstances()) {
    const sup = registry.get(s.instanceId);
    if (!sup) continue;
    if (s.status === "stopped" || s.status === "error") continue;
    const inst = toSpawnedInstance(s, sup);
    const list = result.get(sup.environmentId);
    if (list) {
      list.push(inst);
    } else {
      result.set(sup.environmentId, [inst]);
    }
  }
  return result;
}

export function getInstance(id: string, userId?: string): SpawnedInstance | undefined {
  const facade = getCoreRuntime();
  const snapshot = facade.getInstance(id);
  const sup = registry.get(id);
  if (!snapshot) {
    // core 中不存在实例时清理残留 supplement 避免内存泄漏
    if (sup) registry.unregister(id);
    return;
  }
  if (!sup) return;
  if (userId && sup.userId !== userId) return;
  return toSpawnedInstance(snapshot, sup);
}

/** 用户停止保留显式停止意图，自动调用方必须使用 reclaimInstance。 */
export function stopInstance(id: string, organizationId: string): Promise<{ ok: boolean; error?: string }> {
  return stopInstanceProjection(id, organizationId);
}

/** 自动回收只针对捕获的运行代次；仅活动硬超时可接管挂死定时执行，保留用户停止意图。 */
export function reclaimInstance(
  id: string,
  organizationId: string,
  expectedGeneration: number,
  reason: InstanceReclaimReason = "idle",
): Promise<{ ok: boolean; error?: string }> {
  return stopInstanceProjection(id, organizationId, expectedGeneration, reason);
}

async function stopInstanceProjection(
  id: string,
  organizationId: string,
  expectedGeneration?: number,
  reason: InstanceReclaimReason = "idle",
): Promise<{ ok: boolean; error?: string }> {
  const sup = registry.get(id);
  if (sup && sup.organizationId !== organizationId) return { ok: false, error: "Not your instance" };
  const core = getCoreRuntime().getInstance(id);
  const canReclaim = () => {
    if (!sup || registry.get(id) !== sup || getCoreRuntime().getInstance(id)?.runtimeGeneration !== expectedGeneration)
      return false;
    if (reason === "idle") return !hasActiveAgentExecutions(id);
    return (
      canReclaimInstanceForActivityTimeout(id, sup) &&
      Date.now() - sup.lastActivityAt >= getAgentRuntimeConfig().acpActivityTimeoutSeconds * 1000
    );
  };
  if (expectedGeneration !== undefined) {
    // 缺失投影无法确认租户与代次，旧清理不得按稳定 uid 接管后来者。
    if (!sup || core?.runtimeGeneration !== expectedGeneration) return { ok: false, error: "Runtime changed" };
    if (!canReclaim()) return { ok: false, error: "Instance is active" };
  }
  const controller = getOrchestrationController();
  const active = controller.listInstances().some((instance) => instance.instanceId === id);
  if (!sup && !active && !core) return { ok: false, error: "Already stopped" };
  try {
    if (expectedGeneration === undefined) {
      await agentInstanceRuntimeCoordinator.stopRuntime({ id }, "strict");
    } else {
      let blocked = false;
      await agentInstanceRuntimeCoordinator.reclaimRuntime({ id }, expectedGeneration, () => {
        blocked = !canReclaim();
        return !blocked;
      });
      if (blocked) return { ok: false, error: "Instance is active" };
    }
    return { ok: true };
  } catch (error) {
    logError(`[Instance] Failed to stop orchestration instance ${id}:`, error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 停止所有已知执行投影，任一实体无法确认终止时保留原始失败。 */
export async function stopAllInstances(): Promise<void> {
  const instanceIds = new Set([
    ...getOrchestrationController()
      .listInstances()
      .map((instance) => instance.instanceId),
    ...getCoreRuntime()
      .listInstances()
      .map((instance) => instance.instanceId),
  ]);
  await Promise.all([...instanceIds].map((id) => agentInstanceRuntimeCoordinator.stopRuntime({ id }, "strict")));
}
