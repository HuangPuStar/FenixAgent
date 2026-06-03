import { log, error as logError } from "@fenix/logger";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { machine } from "../db/schema";
import { markHeartbeatTimeout, updateHeartbeat } from "./registry";

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
      await markHeartbeatTimeout(machineId);
    } catch (err) {
      logError("[registry-heartbeat] markTimeout:", err);
    }
    heartbeatMap.delete(machineId);
    onTimeout();
  }, timeoutMs);

  heartbeatMap.set(machineId, { timer, intervalMs: heartbeatIntervalMs, onTimeout });
}

export async function handleHeartbeat(machineId: string): Promise<void> {
  await updateHeartbeat(machineId);

  const entry = heartbeatMap.get(machineId);
  if (entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      log(`[registry-heartbeat] Timeout: id=${machineId}, ${entry.intervalMs * 3}ms no heartbeat`);
      try {
        await markHeartbeatTimeout(machineId);
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

/** 定期巡检：对 DB 中标记为 online 的 machine，检查是否仍有活跃 WS 连接，没有则标 offline */
export function startMachineSweep(intervalMs = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    try {
      const { findMachineConnectionById } = await import("../transport/acp-ws-handler");
      const onlineMachines = await db.select().from(machine).where(eq(machine.status, "online"));
      for (const m of onlineMachines) {
        const conn = findMachineConnectionById(m.id);
        if (!conn) {
          log(`[registry-sweep] Machine ${m.id} has no active WS connection, marking offline`);
          await markHeartbeatTimeout(m.id);
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
