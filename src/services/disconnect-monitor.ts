import { config } from "../config";
import { log, error as logError } from "../logger";
import { environmentRepo } from "../repositories";

export async function runDisconnectMonitorSweep(now = Date.now()) {
  const timeoutMs = config.disconnectTimeout * 1000;

  // Check environment heartbeat timeout
  const envs = await environmentRepo.listActive();
  for (const env of envs) {
    // Skip ACP agents — they use WS keepalive, not polling
    if (env.workerType === "acp") {
      if (env.lastPollAt && now - env.lastPollAt.getTime() > timeoutMs) {
        log(
          `[RCS] ACP agent ${env.id} timed out (no activity for ${Math.round((now - env.lastPollAt.getTime()) / 1000)}s)`,
        );
        await environmentRepo.update(env.id, { status: "idle" });
      }
      continue;
    }
    if (env.lastPollAt && now - env.lastPollAt.getTime() > timeoutMs) {
      log(
        `[RCS] Environment ${env.id} timed out (no poll for ${Math.round((now - env.lastPollAt.getTime()) / 1000)}s)`,
      );
      await environmentRepo.update(env.id, { status: "disconnected" });
    }
  }

  // Session 超时检查已移除 — Session 由 Agent 进程管理
}

export function startDisconnectMonitor() {
  setInterval(() => {
    runDisconnectMonitorSweep().catch((err) => {
      logError("[RCS] Disconnect monitor sweep error:", err);
    });
  }, 60_000); // Check every minute
}
