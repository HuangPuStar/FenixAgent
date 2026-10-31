import type { AgentInstanceRecord } from "../repositories/agent-instance";

/** 停止调用者是否要求确认进程退出。 */
export type RuntimeStopMode = "strict" | "best-effort";
/** 主动进入可解除停止意图，后台运行保证不能解除。 */
export type RuntimeActivation = "automatic" | "explicit";
/** 生命周期仲裁操作，start 保持幂等，restart 强制重新启动。 */
export type RuntimeLifecycleOperation = "ensure" | "start" | "restart" | "stop" | "delete" | "reclaim";
/** 已确认的运行状态；unknown 表示旧实体尚未确认终止。 */
export type RuntimeState = "stopped" | "starting" | "running" | "stopping" | "unknown";

/** 实例运行事实和当前生命周期操作的只读投影。 */
export interface RuntimeSnapshot {
  instanceUid: string;
  runtimeGeneration: number;
  /** 当前生命周期意图的身份，与实际 runtime 代次独立。 */
  operationId: number;
  state: RuntimeState;
  currentOperation: RuntimeLifecycleOperation | null;
  deleting: boolean;
  lastFailure: string | null;
}

/** 仲裁器调用的进程操作与权威运行事实。 */
export interface RuntimeAdapter {
  /** 已确认终止后释放依赖该运行实体的执行配额。 */
  onStopped?(instanceUid: string): void;
  start(instance: AgentInstanceRecord, generation: number, signal: AbortSignal): Promise<void>;
  stop(instanceUid: string, generation: number, signal: AbortSignal): Promise<void>;
  /** 返回编排层或 core 中是否仍存在该 uid 的权威 runtime。 */
  hasActiveRuntime?(instanceUid: string): boolean;
  /** 接管已有 runtime 时读取其实际代次，不能用操作编号代替。 */
  getRuntimeGeneration?(instanceUid: string): number | undefined;
  /** 运行成功快照必须匹配真实 Core 身份，Controller 残留不能作为就绪证明。 */
  isRuntimeReady?(instanceUid: string, generation?: number): boolean;
  /** 显式生命周期操作不按 coordinator 的本地 generation 跳过权威 runtime。 */
  stopActiveRuntime?(instanceUid: string, signal: AbortSignal): Promise<void>;
}

/** 单个实例的进程内生命周期状态，仅由仲裁器持有和修改。 */
export interface RuntimeEntry {
  generation: number;
  operationId: number;
  runtimePresent: boolean;
  state: RuntimeState;
  operation: RuntimeLifecycleOperation | null;
  operationPromise: Promise<void> | null;
  deleting: boolean;
  lastFailure: string | null;
  abortController: AbortController | null;
  /** unknown 的归属机器；新生命周期操作接管或复位后清空。 */
  machineId: string | null;
  /** clean-slate 已确认，在飞操作释放槽位后才允许复位。 */
  pendingCleanSlate: boolean;
  /** 停止意图独立于运行事实，仅主动进入或重启成功后解除。 */
  manuallyStopped: boolean;
}

/** 关闭排空的时间边界。 */
export interface RuntimeCoordinatorOptions {
  shutdownDrainTimeoutMs?: number;
}

/** 仅由机器断连产生、且尚未被其他生命周期意图接管的恢复上下文。 */
export interface RuntimeRecoveryContext {
  machineId: string;
  isCurrent(): boolean;
}
