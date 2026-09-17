import { log, error as logError } from "@fenix/logger";
import { db } from "@server/db";
import { machine } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { touchSandboxInstanceHeartbeatForMachine } from "./machine-sandbox-projection";
import { markHeartbeatTimeout, updateHeartbeat } from "./registry";

const deps = { markHeartbeatTimeout, updateHeartbeat };
const defaultDeps = { ...deps };

/** 测试用：替换 Registry 写入依赖，避免测试进程接触真实 DB。 */
export function setRegistryHeartbeatDeps(overrides: Partial<typeof deps>): void {
  Object.assign(deps, overrides);
}

/** 测试用：恢复 Registry 写入依赖。 */
export function resetRegistryHeartbeatDeps(): void {
  Object.assign(deps, defaultDeps);
}

type HeartbeatEntry = {
  timer: ReturnType<typeof setTimeout>;
  intervalMs: number;
  onTimeout: () => void;
};

const heartbeatMap = new Map<string, HeartbeatEntry>();

export function startHeartbeat(machineId: string, heartbeatIntervalMs: number, onTimeout: () => void): void {
  if (heartbeatMap.has(machineId)) {
    stopHeartbeat(machineId);
  }

  const timeoutMs = heartbeatIntervalMs * 3;

  const timer = setTimeout(async () => {
    log(`[registry-heartbeat] Timeout: id=${machineId}, ${timeoutMs}ms no heartbeat`);
    try {
      await deps.markHeartbeatTimeout(machineId);
    } catch (err) {
      logError("[registry-heartbeat] markTimeout:", err);
    }
    heartbeatMap.delete(machineId);
    onTimeout();
  }, timeoutMs);

  heartbeatMap.set(machineId, { timer, intervalMs: heartbeatIntervalMs, onTimeout });
}

export async function handleHeartbeat(machineId: string): Promise<void> {
  await deps.updateHeartbeat(machineId);
  await touchSandboxInstanceHeartbeatForMachine(machineId);

  const entry = heartbeatMap.get(machineId);
  if (entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      log(`[registry-heartbeat] Timeout: id=${machineId}, ${entry.intervalMs * 3}ms no heartbeat`);
      try {
        await deps.markHeartbeatTimeout(machineId);
      } catch (err) {
        logError("[registry-heartbeat] markTimeout:", err);
      }
      heartbeatMap.delete(machineId);
      entry.onTimeout();
    }, entry.intervalMs * 3);
  }
}

export function stopHeartbeat(machineId: string): void {
  const entry = heartbeatMap.get(machineId);
  if (entry) {
    clearTimeout(entry.timer);
    heartbeatMap.delete(machineId);
  }
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
      const mod = await import("@fenix/agent-runtime/server");
      const onlineMachines = await db.select().from(machine).where(eq(machine.status, "online"));
      for (const m of onlineMachines) {
        const conn = mod.findMachineConnectionById(m.id);
        if (!conn) {
          log(`[registry-sweep] Machine ${m.id} has no active WS connection, triggering disconnect cleanup`);
          await deps.markHeartbeatTimeout(m.id);
          // sweep 检测到的断连无法关联具体 wsId，走 machineId 维度的清理
          mod.triggerMachineCleanupByMachineId(m.id, "sweep: no active WS connection");
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
