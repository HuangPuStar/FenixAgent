import { log, error as logError } from "../logger";
import { environmentRepo, sessionRepo } from "../repositories";
import { config } from "../config";
import { updateSessionStatus } from "./session";

export async function runDisconnectMonitorSweep(now = Date.now()) {
  const timeoutMs = config.disconnectTimeout * 1000;

  // Check environment heartbeat timeout
  const envs = await environmentRepo.listActive();
  for (const env of envs) {
    // Skip ACP agents — they use WS keepalive, not polling
    if (env.workerType === "acp") {
      if (env.lastPollAt && now - env.lastPollAt.getTime() > timeoutMs) {
        log(`[RCS] ACP agent ${env.id} timed out (no activity for ${Math.round((now - env.lastPollAt.getTime()) / 1000)}s)`);
        await environmentRepo.update(env.id, { status: "idle" });
      }
      continue;
    }
    if (env.lastPollAt && now - env.lastPollAt.getTime() > timeoutMs) {
      log(`[RCS] Environment ${env.id} timed out (no poll for ${Math.round((now - env.lastPollAt.getTime()) / 1000)}s)`);
      await environmentRepo.update(env.id, { status: "disconnected" });
    }
  }

  // Check session timeout (2x disconnect timeout with no update)
  const sessions = await sessionRepo.listAll();
  for (const session of sessions) {
    if (session.status === "running" || session.status === "idle") {
      const elapsed = now - session.updatedAt.getTime();
      if (elapsed > timeoutMs * 2) {
        log(`[RCS] Session ${session.id} marked inactive (no update for ${Math.round(elapsed / 1000)}s)`);
        await updateSessionStatus(session.id, "inactive");
      }
    }
  }
}

export function startDisconnectMonitor() {
  setInterval(() => {
    runDisconnectMonitorSweep().catch((err) => {
      logError("[RCS] Disconnect monitor sweep error:", err);
    });
  }, 60_000); // Check every minute
}
