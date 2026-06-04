import { log } from "@fenix/logger";
import { generateWorkerJwt } from "../auth/jwt";
import { config, getBaseUrl } from "../config";
import { environmentRepo, sessionRepo, workItemRepo } from "../repositories";
import type { WorkResponse } from "../types/api";

/** Encode work secret as base64 JSON with a worker JWT as session_ingress_token */
function encodeWorkSecret(sessionId: string): string {
  const token = generateWorkerJwt(sessionId, config.jwtExpiresIn);
  const payload = {
    version: 1,
    session_ingress_token: token,
    api_base_url: getBaseUrl(),
    sources: [] as string[],
    auth: [] as string[],
    use_code_sessions: false,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export async function createWorkItem(environmentId: string, sessionId: string): Promise<string> {
  // Validate environment exists and is active
  const env = await environmentRepo.getById(environmentId);
  if (!env) {
    throw new Error(`Environment ${environmentId} not found`);
  }
  if (env.status !== "active") {
    throw new Error(`Environment ${environmentId} is not active (status: ${env.status})`);
  }

  const secret = encodeWorkSecret(sessionId);
  const record = await workItemRepo.create({ environmentId, sessionId, secret });
  log(`[RCS] Work item created: ${record.id} for env=${environmentId} session=${sessionId}`);
  return record.id;
}

/** Long-poll for work — blocks until work is available or timeout.
 *  Returns null when no work is available, matching the CLI bridge client protocol. */
export async function pollWork(
  environmentId: string,
  timeoutSeconds = config.pollTimeout,
): Promise<WorkResponse | null> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const item = await workItemRepo.getPendingByEnvironment(environmentId);

    if (item) {
      await workItemRepo.update(item.id, { state: "dispatched" });

      return {
        id: item.id,
        type: "work",
        environment_id: environmentId,
        state: "dispatched",
        data: {
          type: "session",
          id: item.sessionId,
        },
        secret: item.secret,
        created_at: item.createdAt.toISOString(),
      };
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return null;
}

export async function ackWork(workId: string) {
  await workItemRepo.update(workId, { state: "acked" });
}

export async function stopWork(workId: string) {
  await workItemRepo.update(workId, { state: "completed" });
}

export async function heartbeatWork(
  workId: string,
): Promise<{ lease_extended: boolean; state: string; last_heartbeat: string; ttl_seconds: number }> {
  await workItemRepo.update(workId, {}); // bump updatedAt
  const item = await workItemRepo.getById(workId);
  const now = new Date();
  return {
    lease_extended: true,
    state: item?.state ?? "acked",
    last_heartbeat: now.toISOString(),
    ttl_seconds: config.heartbeatInterval * 2,
  };
}

/** Reconnect: re-queue sessions associated with an environment */
export async function reconnectWorkForEnvironment(envId: string) {
  const activeSessions = (await sessionRepo.listByEnvironment(envId)).filter((s) => s.status === "idle");
  const promises = activeSessions.map((s) => createWorkItem(envId, s.id));
  return Promise.all(promises);
}
