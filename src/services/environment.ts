import { randomBytes } from "node:crypto";
import { environmentRepo, sessionRepo } from "../repositories";
import type { RegisterEnvironmentRequest, EnvironmentResponse } from "../types/api";
import type { EnvironmentRecord } from "../repositories";

function toResponse(row: EnvironmentRecord): EnvironmentResponse {
  return {
    id: row.id,
    machine_name: row.machineName,
    directory: row.directory,
    branch: row.branch,
    status: row.status,
    username: row.username,
    last_poll_at: row.lastPollAt ? row.lastPollAt.getTime() / 1000 : null,
    worker_type: row.workerType,
    capabilities: row.capabilities,
  };
}

export async function registerEnvironment(req: RegisterEnvironmentRequest & { metadata?: { worker_type?: string }; username?: string; userId?: string }) {
  const secret = `env_${randomBytes(24).toString("hex")}`;
  const workerType = req.worker_type || req.metadata?.worker_type;
  const record = await environmentRepo.create({
    secret,
    userId: req.userId || "system",
    machineName: req.machine_name,
    directory: req.directory,
    branch: req.branch,
    gitRepoUrl: req.git_repo_url,
    maxSessions: req.max_sessions,
    workerType,
    username: req.username,
    capabilities: req.capabilities,
  });

  let sessionId: string | undefined;
  // ACP agents: reuse existing session or create one
  if (workerType === "acp") {
    const existing = await sessionRepo.listByEnvironment(record.id);
    if (existing.length > 0) {
      sessionId = existing[0].id;
    } else {
      const session = await sessionRepo.create({
        environmentId: record.id,
        title: req.machine_name || "ACP Agent",
        source: "acp",
      });
      sessionId = session.id;
    }
  }

  return { environment_id: record.id, environment_secret: record.secret, status: record.status as "active", session_id: sessionId };
}

export async function deregisterEnvironment(envId: string) {
  await environmentRepo.update(envId, { status: "deregistered" });
}

export async function getEnvironment(envId: string) {
  return environmentRepo.getById(envId);
}

export async function updatePollTime(envId: string) {
  await environmentRepo.update(envId, { lastPollAt: new Date() });
}

export async function listActiveEnvironments() {
  return environmentRepo.listActive();
}

export async function listActiveEnvironmentsResponse(): Promise<EnvironmentResponse[]> {
  const envs = await environmentRepo.listActive();
  return envs.map(toResponse);
}

export async function listActiveEnvironmentsByUsername(username: string): Promise<EnvironmentResponse[]> {
  const envs = await environmentRepo.listActiveByUsername(username);
  return envs.map(toResponse);
}

export async function reconnectEnvironment(envId: string) {
  await environmentRepo.update(envId, { status: "active" });
}

/** Delete environment with cascade: dissociate sessions, then delete */
export async function deleteEnvironment(envId: string): Promise<boolean> {
  await sessionRepo.dissociateFromEnvironment(envId);
  return environmentRepo.delete(envId);
}
