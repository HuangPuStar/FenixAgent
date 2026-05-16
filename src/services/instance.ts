import { randomBytes } from "node:crypto";
import { getCoreRuntime } from "./core-bootstrap";
import { buildLaunchSpec } from "./launch-spec-builder";
import { getAgentConfigById, getAgentFullConfig } from "./config-pg";
import { environmentRepo } from "../repositories";
import { log } from "../logger";
import type { RuntimeInstanceSnapshot } from "@mothership/core";

// ────────────────────────────────────────────
// 公共类型（保持向后兼容）
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
    port: (meta.port as number) ?? 0,
    pid: (meta.pid as number | null) ?? null,
    status: mapCoreStatus(snapshot.status),
    command: "",
    error: snapshot.errorMessage ?? null,
    apiKey: (meta.token as string) ?? "",
    createdAt: snapshot.createdAt,
    environmentId: supplement.environmentId,
    sessionId: undefined,
    instanceNumber: supplement.instanceNumber,
  };
}

// ────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────

export async function spawnInstanceFromEnvironment(
  userId: string,
  environmentId: string,
): Promise<SpawnedInstance> {
  const env = await environmentRepo.getById(environmentId);
  if (!env) throw new Error("Environment not found");
  if (env.userId !== userId) throw new Error("Not your environment");

  const cwd = env.workspacePath || env.directory;
  if (!cwd) throw new Error(`Workspace directory not set for environment: ${environmentId}`);

  // 解析 AgentConfig
  let resolvedAgentConfig: { name: string; id?: string } | null = null;
  if (env.agentConfigId) {
    resolvedAgentConfig = await getAgentConfigById(env.agentConfigId);
  } else if (env.agentName) {
    resolvedAgentConfig = { name: env.agentName };
  }

  if (!resolvedAgentConfig) {
    throw new Error(`No agent config found for environment: ${environmentId}`);
  }

  // 获取完整配置
  const fullConfig = resolvedAgentConfig.id && env.userId
    ? await getAgentFullConfig(env.userId, resolvedAgentConfig.id)
    : { agentConfig: null, providers: [], skills: [], mcpServers: [] as any[] };

  // 组装 AgentLaunchSpec
  const ac = fullConfig.agentConfig as Record<string, unknown> | null;
  const launchSpec = await buildLaunchSpec({
    workspacePath: cwd,
    agentName: resolvedAgentConfig.name,
    agentPrompt: (ac?.prompt as string) ?? null,
    modelRef: (ac?.model as string) ?? null,
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

export async function spawnInstance(userId: string): Promise<SpawnedInstance> {
  throw new Error("spawnInstance without environment is deprecated. Use spawnInstanceFromEnvironment instead.");
}

export function listInstances(userId: string): SpawnedInstance[] {
  const facade = getCoreRuntime();
  return facade.listInstances()
    .filter((s) => {
      const sup = supplements.get(s.instanceId);
      return sup?.userId === userId;
    })
    .map((s) => {
      const sup = supplements.get(s.instanceId)!;
      return toSpawnedInstance(s, sup);
    });
}

export function findRunningInstanceByEnvironment(environmentId: string, userId?: string): SpawnedInstance | undefined {
  const facade = getCoreRuntime();
  for (const snapshot of facade.listInstances()) {
    const sup = supplements.get(snapshot.instanceId);
    if (sup?.environmentId === environmentId && snapshot.status === "running") {
      if (userId && sup.userId !== userId) continue;
      return toSpawnedInstance(snapshot, sup);
    }
  }
  return undefined;
}

export function findInstanceBySessionId(_sessionId: string): SpawnedInstance | undefined {
  return undefined;
}

export function listInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  const facade = getCoreRuntime();
  return facade.listInstances()
    .filter((s) => {
      const sup = supplements.get(s.instanceId);
      return sup?.environmentId === environmentId && s.status !== "stopped" && s.status !== "error";
    })
    .map((s) => {
      const sup = supplements.get(s.instanceId)!;
      return toSpawnedInstance(s, sup);
    });
}

export function getRunningInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  const facade = getCoreRuntime();
  return facade.listInstances()
    .filter((s) => {
      const sup = supplements.get(s.instanceId);
      return sup?.environmentId === environmentId && s.status === "running";
    })
    .map((s) => {
      const sup = supplements.get(s.instanceId)!;
      return toSpawnedInstance(s, sup);
    });
}

export function getInstance(id: string, userId?: string): SpawnedInstance | undefined {
  const facade = getCoreRuntime();
  const snapshot = facade.getInstance(id);
  if (!snapshot) return undefined;
  const sup = supplements.get(id);
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
  if (!snapshot) return { ok: false, error: "Instance not found" };
  if (snapshot.status === "stopped") return { ok: false, error: "Already stopped" };

  try {
    await facade.stopInstance(id);
    supplements.delete(id);
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function stopAllInstances(): Promise<void> {
  const facade = getCoreRuntime();
  for (const snapshot of facade.listInstances()) {
    if (snapshot.status !== "stopped") {
      try {
        await facade.stopInstance(snapshot.instanceId);
      } catch {}
    }
  }
  supplements.clear();
  envInstanceCounters.clear();
}

export async function ensureRunning(userId: string, environmentId: string): Promise<EnsureRunningResult> {
  const existing = findRunningInstanceByEnvironment(environmentId);
  if (existing) return { instance: existing, status: "reused" };

  const env = await environmentRepo.getById(environmentId);
  if (!env) throw new Error("Environment not found");

  const runningCount = getRunningInstancesByEnvironment(environmentId).length;
  if (runningCount >= env.maxSessions) {
    throw new Error(`max_sessions_reached: 已达到最大实例数 ${env.maxSessions}`);
  }

  const instance = await spawnInstanceFromEnvironment(userId, environmentId);
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
      throw Object.assign(
        new Error(`实例 ${instanceNumber} 不存在或未运行`),
        { code: "NOT_FOUND" },
      );
    }
  } else {
    const result = await ensureRunning(userId, environmentId);
    inst = result.instance;
  }

  if (!inst) {
    throw Object.assign(new Error("无法创建实例"), { code: "INTERNAL_ERROR" });
  }

  return {
    session_id: inst.sessionId ?? null,
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

/** @deprecated 不再需要，保留空实现避免测试崩溃 */
export function setInstanceSpawnForTesting(_fn: unknown): void {}
