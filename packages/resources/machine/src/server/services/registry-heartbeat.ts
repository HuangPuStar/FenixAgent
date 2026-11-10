import { log, error as logError } from "@fenix/logger";
import { machine } from "@fenix/resource-machine/db";
import { eq } from "drizzle-orm";
import { getMachineDatabase } from "../db";
import { getMachineHostPort } from "../host-port";
import { getMachineLifecyclePort } from "../machine-lifecycle-port";
import { markHeartbeatTimeout, updateHeartbeat } from "./registry";

/** 用例登记的替换值；`null` 表示全部走默认实现。 */
let injected: Partial<{
  markHeartbeatTimeout: typeof markHeartbeatTimeout;
  updateHeartbeat: typeof updateHeartbeat;
}> | null = null;

/**
 * 依赖句柄用 getter 暴露：替换值按**调用时**读取，用例可在本模块 import 之后登记。
 *
 * 历史上本包处在 `machine → agent-runtime → sandbox → machine` 的环上，顶层把导入的 `const` 读进
 * 对象字面量会在环的另一侧入口加载时抛 TDZ（宿主 preload 会加载本包，导致全仓测试一起失败）；
 * 该环已由 1.4 消除（本包不再导入 agent-runtime 与 sandbox），getter 作为替换机制的惰性读取保留。
 */
const deps = {
  get markHeartbeatTimeout(): typeof markHeartbeatTimeout {
    return injected?.markHeartbeatTimeout ?? markHeartbeatTimeout;
  },
  get updateHeartbeat(): typeof updateHeartbeat {
    return injected?.updateHeartbeat ?? updateHeartbeat;
  },
};

/** 测试用：替换 Registry 写入依赖，避免测试进程接触真实 DB。 */
export function setRegistryHeartbeatDeps(overrides: Partial<typeof deps>): void {
  injected = { ...injected, ...overrides };
}

/** 测试用：恢复 Registry 写入依赖。 */
export function resetRegistryHeartbeatDeps(): void {
  injected = null;
}

type HeartbeatEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  intervalMs: number;
  /** 本代计时器的绝对截止时间；刷新时同步前移，旧回调据此判断自己是否已过期。 */
  deadline: number;
  /** 单调代次：每次心跳刷新递增，旧 timeout 回调只认自己那一代。 */
  generation: number;
  /** 创建该计时器的连接身份（machine wsId）；旧连接的心跳与停止不得作用于新连接。 */
  connectionId: string | null;
  onTimeout: () => void;
};

const heartbeatMap = new Map<string, HeartbeatEntry>();

/** map 身份与代次双检：刷新、重注册或 stop 之后，旧回调不得再代表当前连接。 */
function isCurrentGeneration(machineId: string, entry: HeartbeatEntry, generation: number): boolean {
  return heartbeatMap.get(machineId) === entry && entry.generation === generation;
}

/** 同步推进截止时间并重设定时器；调用方必须已持有当前 entry。 */
function armTimer(machineId: string, entry: HeartbeatEntry): void {
  const generation = entry.generation;
  const timeoutMs = entry.intervalMs * 3;
  const deadline = Date.now() + timeoutMs;
  entry.deadline = deadline;
  entry.timer = setTimeout(() => {
    void handleHeartbeatTimeout(machineId, entry, generation, deadline).catch((err) => {
      logError("[registry-heartbeat] timeout callback:", err);
    });
  }, timeoutMs);
}

async function handleHeartbeatTimeout(
  machineId: string,
  entry: HeartbeatEntry,
  generation: number,
  deadline: number,
): Promise<void> {
  if (!isCurrentGeneration(machineId, entry, generation)) return;
  log(`[registry-heartbeat] Timeout: id=${machineId}, ${entry.intervalMs * 3}ms no heartbeat`);

  try {
    // 条件写入：落库期间已经持久化的新心跳优先，旧回调不得把它改写成离线。
    await deps.markHeartbeatTimeout(machineId, new Date(deadline));
  } catch (err) {
    logError("[registry-heartbeat] markTimeout:", err);
  }

  // 落库与事件投影都可能很慢；这期间收到的新心跳、重注册或 stop 必须让本次判定作废。
  if (!isCurrentGeneration(machineId, entry, generation)) return;
  if (Date.now() < deadline) return;

  heartbeatMap.delete(machineId);
  entry.onTimeout();
}

export function startHeartbeat(
  machineId: string,
  heartbeatIntervalMs: number,
  onTimeout: () => void,
  connectionId?: string | null,
): void {
  // 重新注册视为新连接接管：旧计时器与旧回调代次立即失效。
  stopHeartbeat(machineId);

  const entry: HeartbeatEntry = {
    timer: null,
    intervalMs: heartbeatIntervalMs,
    deadline: 0,
    generation: 1,
    connectionId: connectionId ?? null,
    onTimeout,
  };
  armTimer(machineId, entry);
  heartbeatMap.set(machineId, entry);
}

export async function handleHeartbeat(machineId: string, connectionId?: string | null): Promise<void> {
  const entry = heartbeatMap.get(machineId);
  if (entry) {
    if (connectionId != null && entry.connectionId != null && entry.connectionId !== connectionId) {
      // 旧连接的心跳不能延长当前连接的存活期限。
      log(`[registry-heartbeat] Ignoring heartbeat from stale connection: id=${machineId}`);
      return;
    }
    // 网络存活是同步事实：先刷新内存期限，再处理可能失败的持久化与生命周期投影。
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.generation += 1;
    armTimer(machineId, entry);
  }

  // 两个投影彼此独立：一个慢或失败不能阻塞另一个，更不能影响上面已完成的网络存活刷新。
  const projectionNames = ["updateHeartbeat", "notifyMachineHeartbeat"] as const;
  const projections = await Promise.allSettled([
    deps.updateHeartbeat(machineId),
    // 事件时刻由调用方给出（端口不自己取时）：与 `registry.ts` 的注册通知同一口径，投影写入的时间戳因此
    // 可被用例断言，而不是藏在接收方内部。
    Promise.resolve(getMachineLifecyclePort()?.notifyMachineHeartbeat(machineId, new Date())),
  ]);
  projections.forEach((result, index) => {
    if (result.status === "rejected") {
      logError(`[registry-heartbeat] ${projectionNames[index]}:`, result.reason);
    }
  });
}

export function stopHeartbeat(machineId: string, connectionId?: string | null): void {
  const entry = heartbeatMap.get(machineId);
  if (!entry) return;
  if (connectionId != null && entry.connectionId != null && entry.connectionId !== connectionId) {
    // 旧连接关闭时不得清掉新连接刚注册的计时器。
    return;
  }
  if (entry.timer !== null) clearTimeout(entry.timer);
  heartbeatMap.delete(machineId);
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 定期巡检：对 DB 中标记为 online 的 machine，检查是否仍有活跃 WS 连接。
 * 没有 active WS 的 machine 视为断连：标记 offline 并触发 relay 清理，
 * 使前端能感知远程节点已不可达。
 */
export function startMachineSweep(intervalMs = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    try {
      const onlineMachines = await getMachineDatabase().select().from(machine).where(eq(machine.status, "online"));
      const hostPort = getMachineHostPort();
      for (const m of onlineMachines) {
        const conn = hostPort.findMachineConnectionById(m.id);
        if (!conn) {
          log(`[registry-sweep] Machine ${m.id} has no active WS connection, triggering disconnect cleanup`);
          await deps.markHeartbeatTimeout(m.id);
          // sweep 检测到的断连无法关联具体 wsId，走 machineId 维度的清理
          hostPort.triggerMachineCleanupByMachineId(m.id, "sweep: no active WS connection");
        }
      }
    } catch (err) {
      logError("[registry-sweep] Sweep error:", err);
    }
  }, intervalMs);
}

export function stopMachineSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
