// ────────────────────────────────────────────
// 编排域重构保留说明（I4：旧代码删除与精简）
// ────────────────────────────────────────────
// 实例生命周期（启动/停止）已统一收敛到编排域：启动走 orchestration-instance 的
// spawnInstanceViaController（controller.spawnInstance 环境校验/并发治理/节点获取 →
// core launchInstance → registerSupplement），停止走 stopInstanceViaController
// （活跃表移除 + 节点引用归还 → core 停止 → supplement 清理）。本文件不再承载
// 启动/停止的完整实现，仅保留：
//   1. RCS 业务查询层（listInstances / getInstance / findRunningInstanceByEnvironment
//      等，读 core 运行时快照 + globalInstanceRegistry supplement）；
//   2. ensureRunning / enterEnvironment 的会话语义（复用运行实例、autoStart /
//      maxSessions 检查，spawn 分支委托编排域入口）；
//   3. stopInstance / stopAllInstances 作为编排域停止入口的薄委托层，保留组织归属
//      校验与"已停止幂等"语义，供 web DELETE / acp-idle-monitor / graceful shutdown 使用。
// 旧 spawnInstanceFromEnvironment / findInstanceBySessionId / SpawnInstanceOptions
// 已在休克疗法中删除，不再恢复。
import type { RuntimeInstanceSnapshot } from "@fenix/core";
import { error as logError } from "@fenix/logger";
import { AppError, NotFoundError } from "../errors";
import { environmentRepo } from "../repositories";
import type { InstanceSpawnSource, InstanceSupplement } from "../types/store";
import { getCoreRuntime } from "./core-bootstrap";
import { globalInstanceRegistry } from "./instance-registry";
import { createInstanceSessionId } from "./instance-session";
import { getOrchestrationController } from "./orchestration-bootstrap";
import { spawnInstanceViaController, stopInstanceViaController } from "./orchestration-instance";

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
  instanceNumber: number;
}

/** 对外 `/web/instances/*` API 使用的实例详情结构。 */
export interface InstanceInfo {
  id: string;
  port: number;
  status: "starting" | "running" | "stopped" | "error";
  error: string | null;
  group_id: string;
  environment_id: string | null;
  session_id: string | null;
  instance_number: number;
  created_at: number;
}

/**
 * toInstanceInfo 的输入视图：兼容旧路径 SpawnedInstance（id 字段）与编排域
 * Instance（instanceId 字段 + status() 方法）。编排域 Instance 数据面不携带
 * port/error/createdAt/instanceNumber 等展示字段，由 toInstanceInfo 实现从
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
  instanceNumber?: number;
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
    instanceNumber: supplement.instanceNumber,
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
 *      其 port/error/createdAt/instanceNumber 由实现从 core 运行时快照与
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
  let instanceNumber = instance.instanceNumber ?? 0;
  let createdAt = instance.createdAt;

  // 编排域 Instance 分支（仅 instanceId、无 id 字段）：core 快照补 port/error/createdAt，
  // supplement 补 instanceNumber。SpawnedInstance 必带 id，不会进入此分支。
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
      instanceNumber = sup.instanceNumber;
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
    instance_number: instanceNumber,
    created_at: createdAt ? Math.floor(createdAt.getTime() / 1000) : 0,
  };
}

/** 将实例与 registry 中的空闲观测状态组装为监控视图。 */
export function toInstanceActivityInfo(
  instance: SpawnedInstance,
  supplement: InstanceSupplement,
  idleTimeoutSeconds: number,
  activityTimeoutSeconds: number,
  now = Date.now(),
): InstanceActivityInfo {
  const idleSince = supplement.lastRelayDetachedAt ?? now;
  const idleSeconds = supplement.relayCount === 0 ? Math.max(0, Math.floor((now - idleSince) / 1000)) : 0;
  const inactivitySeconds = Math.max(0, Math.floor((now - supplement.lastActivityAt) / 1000));
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
    idle_kill_eligible: supplement.relayCount === 0 && idleSeconds >= idleTimeoutSeconds,
    inactivity_seconds: inactivitySeconds,
    activity_timeout_seconds: activityTimeoutSeconds,
    activity_kill_eligible: inactivitySeconds >= activityTimeoutSeconds,
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

export async function stopInstance(id: string, organizationId: string): Promise<{ ok: boolean; error?: string }> {
  const sup = registry.get(id);
  if (!sup) return { ok: false, error: "Instance not found" };
  if (sup.organizationId !== organizationId) return { ok: false, error: "Not your instance" };

  // 休克疗法（I4）：实例生命周期统一收敛到编排域，旧 core fallback 分支已删除。
  // controller 活跃表无记录即视为实例已不存在——部署后不存在非编排域实例，
  // 语义收紧是预期结果（web DELETE 由 404/403 兜底，acp-idle-monitor 静默跳过）。
  const controller = getOrchestrationController();
  const isOrchestrationInstance = controller.listInstances().some((inst) => inst.instanceId === id);
  if (!isOrchestrationInstance) {
    return { ok: false, error: "Instance not found" };
  }

  try {
    // stopInstanceViaController 内部对 controller.stopInstance / core stopInstance
    // 均幂等吞错，因此重复停止编排域实例仍返回成功——保持 web DELETE
    // "已停止 → 200" 的语义（原 "Already stopped" 分支由编排域幂等取代）。
    await stopInstanceViaController(id);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[Instance] Failed to stop orchestration instance ${id}:`, err);
    return { ok: false, error: message };
  }
}

export async function stopAllInstances(): Promise<void> {
  // 休克疗法（I4）：优先遍历编排域活跃表走 stopInstanceViaController（活跃表移除 +
  // 节点引用归还 + core 停止 + supplement 清理，内部对已停止实例幂等吞错），
  // 再兜底 core 中非编排域残留实例，最后清空 supplement 注册表。
  const controller = getOrchestrationController();
  const orchestrationIds = controller.listInstances().map((inst) => inst.instanceId);
  await Promise.all(
    orchestrationIds.map(async (instanceId) => {
      try {
        await stopInstanceViaController(instanceId);
      } catch (err: unknown) {
        logError(`[Instance] Failed to stop orchestration instance ${instanceId}:`, err);
      }
    }),
  );

  // 兜底：core 中仍活跃且不在编排域活跃表的实例（旧路径遗留，部署后不存在）
  const facade = getCoreRuntime();
  await Promise.all(
    facade
      .listInstances()
      .filter((s) => s.status !== "stopped" && s.status !== "stopping" && !orchestrationIds.includes(s.instanceId))
      .map(async (snapshot) => {
        try {
          await facade.stopInstance(snapshot.instanceId);
        } catch (err: unknown) {
          logError(`[Instance] Failed to stop ${snapshot.instanceId}:`, err);
        }
      }),
  );
  registry.clear();
}

export async function ensureRunning(
  userId: string,
  environmentId: string,
  source: InstanceSpawnSource = "interactive",
  instanceNumber?: number,
): Promise<EnsureRunningResult> {
  const runningInstances = getRunningInstancesByEnvironment(environmentId);

  // 指定了 instanceNumber：精准匹配该编号的运行实例
  if (instanceNumber !== undefined) {
    const targetInstance = runningInstances.find((i) => i.instanceNumber === instanceNumber);
    if (targetInstance) return { instance: targetInstance, status: "reused" };

    // 目标实例未运行，尝试新启
    const env = await environmentRepo.getById(environmentId);
    if (!env) throw new NotFoundError("Environment not found");

    if (!env.autoStart) {
      throw new AppError(`实例 ${instanceNumber} 未运行且 autoStart 已禁用`, "AUTO_START_DISABLED", 409);
    }

    const currentRunning = getRunningInstancesByEnvironment(environmentId);
    if (currentRunning.length >= env.maxSessions) {
      // 目标实例未运行且已达上限时，回退到首个运行实例（relay key 已做隔离，共享实例不会串数据）
      if (currentRunning[0]) return { instance: currentRunning[0], status: "reused" };
      throw new AppError(`已达到最大实例数 ${env.maxSessions}`, "MAX_SESSIONS_REACHED", 409);
    }

    const instance = await spawnViaOrchestration(userId, environmentId, source);
    return { instance, status: "spawned" };
  }

  // 未指定 instanceNumber：复用第一个运行实例
  const existing = runningInstances[0];
  if (existing) return { instance: existing, status: "reused" };

  const env = await environmentRepo.getById(environmentId);
  if (!env) throw new NotFoundError("Environment not found");

  if (!env.autoStart) {
    throw new AppError("Instance not running and autoStart is disabled", "AUTO_START_DISABLED", 409);
  }

  // async gap 后重新检查：await 期间可能有并发请求新启了实例
  const currentRunning = getRunningInstancesByEnvironment(environmentId);
  if (currentRunning.length >= env.maxSessions) {
    // 并发场景下另一个请求可能已启动实例，优先复用
    if (currentRunning[0]) return { instance: currentRunning[0], status: "reused" };
    throw new AppError(`已达到最大实例数 ${env.maxSessions}`, "MAX_SESSIONS_REACHED", 409);
  }

  const instance = await spawnViaOrchestration(userId, environmentId, source);
  return { instance, status: "spawned" };
}

/**
 * 编排域启动并组装 RCS SpawnedInstance（ensureRunning 的 spawn 分支专用）。
 *
 * spawnInstanceViaController 内部已完成 core launchInstance + registerSupplement，
 * 因此 getInstance 必然命中；防御性判空用于在编排域未来调整注册时机时快速定位，
 * 而不是静默返回空实例导致调用方解引用崩溃。
 */
async function spawnViaOrchestration(
  userId: string,
  environmentId: string,
  source: InstanceSpawnSource,
): Promise<SpawnedInstance> {
  const orchestrationInstance = await spawnInstanceViaController(environmentId, userId, source);
  const instance = getInstance(orchestrationInstance.instanceId);
  if (!instance) {
    throw new AppError(
      `Instance '${orchestrationInstance.instanceId}' spawned but missing from runtime registry`,
      "INSTANCE_NOT_VISIBLE",
      500,
    );
  }
  return instance;
}

// ────────────────────────────────────────────
// 响应组装视图函数（供路由层直接返回）
// ────────────────────────────────────────────

export interface EnterEnvironmentResult {
  session_id: string | null;
  instance_id: string;
  instance_number: number;
  instance_status: string;
  environment_id: string;
}

export async function enterEnvironment(
  userId: string,
  environmentId: string,
  instanceNumber?: number,
): Promise<EnterEnvironmentResult> {
  let inst: SpawnedInstance | undefined;

  if (instanceNumber !== undefined) {
    const runningInstances = getRunningInstancesByEnvironment(environmentId);
    inst = runningInstances.find((i) => i.instanceNumber === instanceNumber);
    if (!inst) {
      throw new NotFoundError(`实例 ${instanceNumber} 不存在或未运行`);
    }
  } else {
    const result = await ensureRunning(userId, environmentId);
    inst = result.instance;
  }

  // 为该实例生成确定性会话 ID（agent_session 表已废弃，不再持久化 "Instance N" 标题会话）。
  // 同一环境 + 同一实例编号始终得到相同 ID；前端透传后在 YJS WS 连接时解析实例编号。
  const sessionId = createInstanceSessionId(environmentId, inst.instanceNumber);

  return {
    session_id: sessionId,
    instance_id: inst.id,
    instance_number: inst.instanceNumber,
    instance_status: inst.status,
    environment_id: environmentId,
  };
}

export interface InstanceListResponse {
  environment_id: string;
  instances: Array<{
    id: string;
    instance_number: number;
    status: string;
    session_id: string | null;
    port: number | undefined;
    created_at: number;
  }>;
}

export function listInstancesResponse(environmentId: string): InstanceListResponse {
  const activeInstances = listInstancesByEnvironment(environmentId);
  return {
    environment_id: environmentId,
    instances: activeInstances.map((inst) => ({
      id: inst.id,
      instance_number: inst.instanceNumber,
      status: inst.status,
      session_id: inst.sessionId ?? null,
      port: inst.port,
      created_at: Math.floor(inst.createdAt.getTime() / 1000),
    })),
  };
}
