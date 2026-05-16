import { randomBytes } from "node:crypto";
import { getCoreRuntime } from "./core-bootstrap";
import { buildLaunchSpec } from "./launch-spec-builder";
import { getAgentConfigById, getAgentFullConfig } from "./config-pg";
import { environmentRepo } from "../repositories";
import type { EnvironmentRecord } from "../repositories";
import { findOrCreateForEnvironment } from "./session";
import { log, error as logError } from "../logger";
import { NotFoundError, AppError } from "../errors";
import type { RuntimeInstanceSnapshot } from "@mothership/core";
import type { AgentFullConfig } from "./config-pg";

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

export interface EnsureRunningResult {
  instance: SpawnedInstance;
  status: "reused" | "spawned";
}

// ────────────────────────────────────────────
// 补充映射：core 不维护的 RCS 业务字段
// ────────────────────────────────────────────

interface InstanceSupplement {
  userId: string;
  environmentId: string;
  instanceNumber: number;
}

const supplements = new Map<string, InstanceSupplement>();
const envInstanceCounters = new Map<string, number>();

function getNextInstanceNumber(environmentId: string): number {
  const current = envInstanceCounters.get(environmentId) ?? 0;
  const next = current + 1;
  envInstanceCounters.set(environmentId, next);
  return next;
}

function mapCoreStatus(
  status: import("@mothership/core").RuntimeInstanceStatus,
): SpawnedInstance["status"] {
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
function toSpawnedInstance(
  snapshot: RuntimeInstanceSnapshot,
  supplement: InstanceSupplement,
): SpawnedInstance {
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

// ────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────

/** 统一的实例查询+转换：按 filter 条件筛选，再转为 SpawnedInstance */
function filterInstances(
  predicate: (snapshot: RuntimeInstanceSnapshot, sup: InstanceSupplement) => boolean,
): SpawnedInstance[] {
  const facade = getCoreRuntime();
  return facade.listInstances()
    .flatMap((s) => {
      const sup = supplements.get(s.instanceId);
      if (!sup) return [];
      if (!predicate(s, sup)) return [];
      return [toSpawnedInstance(s, sup)];
    });
}

export async function spawnInstanceFromEnvironment(
  userId: string,
  environmentId: string,
  prefetchedEnv?: EnvironmentRecord,
): Promise<SpawnedInstance> {
  const env = prefetchedEnv ?? await environmentRepo.getById(environmentId);
  if (!env) throw new NotFoundError("Environment not found");
  if (env.userId !== userId) throw new AppError("Not your environment", "FORBIDDEN", 403);

  const cwd = env.workspacePath ?? env.directory;
  if (!cwd) throw new AppError(`Workspace directory not set for environment: ${environmentId}`, "VALIDATION_ERROR", 400);

  // 解析 AgentConfig：有则加载完整配置，无则用默认 "general" agent
  let agentName = "general";
  let agentPrompt: string | null = null;
  let modelRef: string | null = null;
  let fullConfig: AgentFullConfig;

  if (env.agentConfigId) {
    const resolvedAgentConfig = await getAgentConfigById(env.agentConfigId);
    if (!resolvedAgentConfig) {
      throw new NotFoundError(`AgentConfig '${env.agentConfigId}' not found`);
    }
    fullConfig = await getAgentFullConfig(env.userId, resolvedAgentConfig.id);
    const ac = fullConfig.agentConfig as Record<string, unknown> | null;
    agentName = resolvedAgentConfig.name;
    agentPrompt = typeof ac?.prompt === "string" ? ac.prompt : null;
    modelRef = typeof ac?.model === "string" ? ac.model : null;
  } else {
    fullConfig = await getAgentFullConfig(env.userId, null);
  }

  // 组装 AgentLaunchSpec
  const launchSpec = await buildLaunchSpec({
    workspacePath: cwd,
    agentName,
    agentPrompt,
    modelRef,
    fullConfig,
    environmentSecret: env.secret,
  });

  const instanceId = `inst_${randomBytes(8).toString("hex")}`;
  const instanceNumber = getNextInstanceNumber(environmentId);

  // 委托 core 执行 launch
  // port/token/pid 由 core-bootstrap 的 onInstanceStarted 回调写入 pluginMetadata
  const facade = getCoreRuntime();
  const snapshot = await facade.launchInstance({
    instanceId,
    engineType: "opencode",
    nodeId: "local-default",
    launchSpec,
  });

  const supplement: InstanceSupplement = {
    userId,
    environmentId,
    instanceNumber,
  };
  supplements.set(instanceId, supplement);

  return toSpawnedInstance(snapshot, supplement);
}

export function listInstances(userId: string): SpawnedInstance[] {
  return filterInstances((_s, sup) => sup.userId === userId);
}

export function findRunningInstanceByEnvironment(environmentId: string, userId?: string): SpawnedInstance | undefined {
  const results = filterInstances((s, sup) =>
    sup.environmentId === environmentId && s.status === "running" && (!userId || sup.userId === userId),
  );
  return results[0];
}

export function findInstanceBySessionId(_sessionId: string): SpawnedInstance | undefined {
  return undefined;
}

export function listInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  return filterInstances((s, sup) =>
    sup.environmentId === environmentId && s.status !== "stopped" && s.status !== "error",
  );
}

export function getRunningInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  return filterInstances((s, sup) =>
    sup.environmentId === environmentId && s.status === "running",
  );
}

/** 一次遍历：按 environmentId 分组所有活跃实例，避免 N 次 listInstances 调用 */
export function groupActiveInstancesByEnvironment(): Map<string, SpawnedInstance[]> {
  const facade = getCoreRuntime();
  const result = new Map<string, SpawnedInstance[]>();
  for (const s of facade.listInstances()) {
    const sup = supplements.get(s.instanceId);
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
  const sup = supplements.get(id);
  if (!snapshot) {
    // core 中不存在实例时清理残留 supplement 避免内存泄漏
    if (sup) supplements.delete(id);
    return undefined;
  }
  if (!sup) return undefined;
  if (userId && sup.userId !== userId) return undefined;
  return toSpawnedInstance(snapshot, sup);
}

export async function stopInstance(id: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const sup = supplements.get(id);
  if (!sup) return { ok: false, error: "Instance not found" };
  if (sup.userId !== userId) return { ok: false, error: "Not your instance" };

  const facade = getCoreRuntime();
  const snapshot = facade.getInstance(id);
  if (!snapshot) {
    // core 中不存在实例时清理残留 supplement 避免内存泄漏
    supplements.delete(id);
    return { ok: false, error: "Instance not found" };
  }
  if (snapshot.status === "stopped" || snapshot.status === "stopping") {
    // 已停止实例清理 supplement
    supplements.delete(id);
    return { ok: false, error: "Already stopped" };
  }

  try {
    await facade.stopInstance(id);
    supplements.delete(id);
    // 清理环境级计数器：无活跃实例时释放 Map 条目
    const remaining = getRunningInstancesByEnvironment(sup.environmentId);
    if (remaining.length === 0) {
      envInstanceCounters.delete(sup.environmentId);
    }
    log(`[Instance] Stopped instance ${id}`);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[Instance] Failed to stop instance ${id}:`, err);
    return { ok: false, error: message };
  }
}

export async function stopAllInstances(): Promise<void> {
  const facade = getCoreRuntime();
  const active = facade.listInstances()
    .filter(s => s.status !== "stopped" && s.status !== "stopping");

  // 并行停止所有活跃实例（每个实例独立，互不依赖）
  await Promise.all(
    active.map(async (snapshot) => {
      try {
        await facade.stopInstance(snapshot.instanceId);
      } catch (err: unknown) {
        logError(`[Instance] Failed to stop ${snapshot.instanceId}:`, err);
      }
    }),
  );
  supplements.clear();
  envInstanceCounters.clear();
}

export async function ensureRunning(userId: string, environmentId: string): Promise<EnsureRunningResult> {
  const runningInstances = getRunningInstancesByEnvironment(environmentId);
  const existing = runningInstances[0];
  if (existing) return { instance: existing, status: "reused" };

  const env = await environmentRepo.getById(environmentId);
  if (!env) throw new NotFoundError("Environment not found");

  // async gap 后重新检查：await 期间可能有并发请求新启了实例
  const currentRunning = getRunningInstancesByEnvironment(environmentId);
  if (currentRunning.length >= env.maxSessions) {
    // 并发场景下另一个请求可能已启动实例，优先复用
    if (currentRunning[0]) return { instance: currentRunning[0], status: "reused" };
    throw new AppError(`已达到最大实例数 ${env.maxSessions}`, "MAX_SESSIONS_REACHED", 409);
  }

  const instance = await spawnInstanceFromEnvironment(userId, environmentId, env);
  return { instance, status: "spawned" };
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

  // 为该环境查找或创建 RCS session（前端导航需要 session_id）
  const { id: sessionId } = await findOrCreateForEnvironment(
    environmentId,
    "Web Session",
    userId,
    "web",
  );

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
