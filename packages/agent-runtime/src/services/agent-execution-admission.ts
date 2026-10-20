import { AppError } from "@fenix/platform-sdk";
import { getAgentRuntimeConfig } from "../server/config";
import type { InstanceSpawnSource } from "../types/instance";
import { globalInstanceRegistry } from "./instance-registry";

interface Execution {
  readonly userId: string;
  readonly source: InstanceSpawnSource;
  instanceId?: string;
  runtimeConfirmed?: boolean;
}

/** 单次执行占用配额；实例复用不复用任务额度。 */
export interface AgentExecutionLease {
  /** 解析持久实例后绑定回收保护，必须在启动 runtime 之前调用。 */
  attach(instanceId: string): void;
  /** runtime就绪后确认本执行已进入该实体；终止前等待ensure的任务不会被旧实体回收。 */
  confirmRuntime(): void;
  /** 仅在执行终态已确认或 runtime 已确认终止后释放。 */
  release(): void;
}

const executions = new Set<Execution>();

/** 同步准入每次执行；scheduled 上限计数执行任务，实例容量继续由 spawn reservation 治理。 */
export function acquireAgentExecution(input: {
  userId: string;
  source: InstanceSpawnSource;
  signal?: AbortSignal;
}): AgentExecutionLease {
  input.signal?.throwIfAborted();
  const limit = getAgentRuntimeConfig().scheduledAgentMaxConcurrency;
  if (input.source === "scheduled" && limit !== undefined) {
    let active = 0;
    for (const execution of executions) if (execution.source === "scheduled") active++;
    if (active >= limit) {
      throw new AppError("Scheduled Agent execution limit reached", "SCHEDULED_AGENT_CONCURRENCY_LIMIT_REACHED", 429);
    }
  }
  const execution: Execution = { userId: input.userId, source: input.source };
  executions.add(execution);
  let released = false;
  return {
    attach(instanceId) {
      if (released || !executions.has(execution)) throw new Error("Agent execution lease is no longer active");
      if (execution.instanceId && execution.instanceId !== instanceId)
        throw new Error("Agent execution lease is already bound");
      execution.instanceId = instanceId;
    },
    confirmRuntime() {
      if (released || !executions.has(execution)) throw new Error("Agent execution runtime has terminated");
      if (!execution.instanceId) throw new Error("Agent execution lease has no instance");
      execution.runtimeConfirmed = true;
    },
    release() {
      if (released) return;
      released = true;
      executions.delete(execution);
      if (execution.instanceId) globalInstanceRegistry.touchActivity(execution.instanceId);
    },
  };
}

/** 回收必须尊重全部来源的活跃执行，包括没有输出的后台任务。 */
export function hasActiveAgentExecutions(instanceId: string): boolean {
  for (const execution of executions) if (execution.instanceId === instanceId) return true;
  return false;
}

/** 程序化 api/workflow 实例可在无执行时回收；交互 chat 沿用其显式生命周期。 */
export function isAgentExecutionIdleReclaimable(instanceId: string): boolean {
  return (
    !hasActiveAgentExecutions(instanceId) && globalInstanceRegistry.get(instanceId)?.executionIdleReclaimable === true
  );
}

/** 将程序化实例的回收策略写入现有运行投影，避免由首次启动来源决定。 */
export function markAgentExecutionIdleReclaimable(instanceId: string): void {
  const supplement = globalInstanceRegistry.get(instanceId);
  if (supplement) supplement.executionIdleReclaimable = true;
}

/** 已确认 runtime 终止时收回该实例的全部执行额度，包括无法确认取消的执行。 */
export function releaseAgentExecutions(instanceId: string): void {
  for (const execution of executions)
    if (execution.instanceId === instanceId && execution.runtimeConfirmed) executions.delete(execution);
}
