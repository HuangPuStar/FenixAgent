import { randomBytes } from "node:crypto";
import type { RuntimeInstanceSnapshot } from "@fenix/core";
import { log, error as logError } from "@fenix/logger";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { getBaseUrl } from "../config";
import { validateEnv } from "../env";
import { AppError, NotFoundError } from "../errors";
import type { EnvironmentRecord } from "../repositories";
import { environmentRepo } from "../repositories";
import { findMachineConnectionById } from "../transport/acp-ws-handler";
import type { InstanceSupplement } from "../types/store";
import { getReadableAgentConfigById } from "./config/index";
import { getCoreRuntime } from "./core-bootstrap";
import { globalInstanceRegistry } from "./instance-registry";
import { buildBasicLaunchSpec, buildLaunchSpec } from "./launch-spec-builder";
import { _sessionRepo } from "./session";

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
 */
export function toInstanceInfo(instance: SpawnedInstance): InstanceInfo {
  const environmentId = instance.environmentId ?? null;
  return {
    id: instance.id,
    port: instance.port,
    status: instance.status,
    error: instance.error,
    // 现有 API 契约要求 group_id 必填；当前实例域里没有独立 group 概念，
    // 这里沿用 environmentId 作为兼容值，后续若拆分语义需同步调整 schema 与客户端。
    group_id: environmentId ?? "",
    environment_id: environmentId,
    session_id: instance.sessionId ?? null,
    instance_number: instance.instanceNumber,
    created_at: Math.floor(instance.createdAt.getTime() / 1000),
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

/**
 * 基于 environment 配置启动一个新实例。
 *
 * 绑定了 agentConfig 时走完整资源解析；未绑定时只注入一个最小 LaunchSpec，
 * 让环境仍可启动，但不会偷偷继承 prompt / skills / MCP 等额外配置。
 *
 * 这条“无 AgentConfig”分支主要给系统级环境使用，例如平台自举阶段的
 * meta-agent。这里把场景约束放在 instance 层，而不是 launch-spec builder，
 * 避免底层组装器耦合具体业务概念。
 */
export async function spawnInstanceFromEnvironment(
  userId: string,
  environmentId: string,
  prefetchedEnv?: EnvironmentRecord,
  extraEnv?: Record<string, string>,
): Promise<SpawnedInstance> {
  const env = prefetchedEnv ?? (await environmentRepo.getById(environmentId));
  if (!env) throw new NotFoundError("Environment not found");
  log(
    `[instance] spawnInstanceFromEnvironment: environmentId='${environmentId}', org='${env.organizationId ?? ""}', user='${userId}', agentConfigId='${env.agentConfigId ?? ""}'`,
  );

  // Phase 1: 注入平台级环境变量，调用方仍可通过 extraEnv 覆盖这些默认值。
  const platformEnv: Record<string, string> = {
    USER_META_API_KEY: env.secret,
    USER_META_BASE_URL: getBaseUrl(),
  };
  const mergedExtraEnv = { ...platformEnv, ...extraEnv };

  // Phase 2: 有 agentConfig 时走完整 builder；没有时降级为最小可运行配置。
  let agentMachineId: string | null = null;
  const launchContext = {
    organizationId: env.organizationId ?? userId,
    userId: env.userId ?? userId,
    environmentId,
    extraEnv: mergedExtraEnv,
  };
  let launchSpec: AgentLaunchSpec;
  if (env.agentConfigId) {
    const agentConfigId = env.agentConfigId;
    const accessCtx = { organizationId: env.organizationId ?? "", userId, role: "owner" as const };
    const resolvedAgentConfig = await getReadableAgentConfigById(accessCtx, agentConfigId);
    if (!resolvedAgentConfig) {
      logError(
        `[instance] spawnInstanceFromEnvironment: agentConfigId='${agentConfigId}' not found for environmentId='${environmentId}', org='${env.organizationId ?? ""}'`,
      );
      throw new NotFoundError(`AgentConfig '${agentConfigId}' not found`);
    }
    agentMachineId = resolvedAgentConfig.machineId ?? null;
    log(
      `[instance] spawnInstanceFromEnvironment: resolved agentConfig id='${resolvedAgentConfig.id}', sourceOrg='${resolvedAgentConfig.organizationId}', modelId='${resolvedAgentConfig.modelId ?? ""}', machineId='${agentMachineId ?? ""}'`,
    );
    launchSpec = await buildLaunchSpec({
      ...launchContext,
      agentConfig: resolvedAgentConfig,
      environmentSecret: env.secret,
    });
  } else {
    log(
      `[instance] spawnInstanceFromEnvironment: environmentId='${environmentId}' has no agentConfigId, fallback to minimal launch spec`,
    );
    launchSpec = await buildBasicLaunchSpec(launchContext);
  }
  log(
    `[instance] spawnInstanceFromEnvironment: launchSpec.model provider='${launchSpec.model.provider}', model='${launchSpec.model.model}', modelName='${launchSpec.model.modelName ?? ""}', baseUrl='${launchSpec.model.baseUrl}', hasApiKey=${Boolean(launchSpec.model.apiKey)}`,
  );

  const instanceId = `inst_${randomBytes(8).toString("hex")}`;
  const instanceNumber = registry.nextInstanceNumber(environmentId);

  // machineId 缺失时固定落到本地 node，避免把“未绑定远程机”误解释成启动错误。
  let nodeId = "local-default";
  if (agentMachineId) {
    nodeId = agentMachineId;
  }

  // 远程节点启动前连接检查
  if (nodeId !== "local-default") {
    const machineConn = findMachineConnectionById(nodeId);
    if (!machineConn) {
      throw new AppError(`远程节点 '${nodeId}' 未连接，无法启动实例`, "MACHINE_OFFLINE", 503);
    }
  }

  // 委托 core 执行 launch
  // port/token/pid 由 core-bootstrap 的 onInstanceStarted 回调写入 pluginMetadata
  const facade = getCoreRuntime();
  const snapshot = await facade.launchInstance({
    instanceId,
    engineType: validateEnv().RCS_ENGINE_TYPE,
    nodeId,
    launchSpec,
  });

  const supplement: InstanceSupplement = {
    userId,
    environmentId,
    instanceNumber,
    organizationId: env.organizationId ?? userId,
  };
  registry.register(instanceId, supplement);

  return toSpawnedInstance(snapshot, supplement);
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

export function findInstanceBySessionId(_sessionId: string): SpawnedInstance | undefined {
  return;
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

  const facade = getCoreRuntime();
  const snapshot = facade.getInstance(id);
  if (!snapshot) {
    registry.unregister(id);
    return { ok: false, error: "Instance not found" };
  }
  if (snapshot.status === "stopped" || snapshot.status === "stopping") {
    registry.unregister(id);
    return { ok: false, error: "Already stopped" };
  }

  try {
    await facade.stopInstance(id);
    registry.unregister(id);
    // 清理环境级计数器：无活跃实例时释放 Map 条目
    const remaining = getRunningInstancesByEnvironment(sup.environmentId);
    if (remaining.length === 0) {
      registry.deleteCounter(sup.environmentId);
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
  const active = facade.listInstances().filter((s) => s.status !== "stopped" && s.status !== "stopping");

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
  registry.clear();
}

export async function ensureRunning(userId: string, environmentId: string): Promise<EnsureRunningResult> {
  const runningInstances = getRunningInstancesByEnvironment(environmentId);
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

  // 为该实例查找或创建独立 session（多实例场景下每个实例需要独立 session）
  const sessions = await _sessionRepo.listByEnvironment(environmentId);
  const existingSession = sessions.find((s) => s.title === `Instance ${inst.instanceNumber}`);
  let sessionId: string;
  if (existingSession) {
    sessionId = existingSession.id;
  } else {
    const session = await _sessionRepo.create({
      environmentId,
      title: `Instance ${inst.instanceNumber}`,
      source: "web",
      userId,
    });
    sessionId = session.id;
  }

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
