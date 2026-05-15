import { environmentRepo, sessionRepo, shareLinkRepo } from "../repositories";
import { eventService } from "../services/event-service";
import type { CreateSessionRequest, CreateCodeSessionRequest, SessionResponse, SessionSummaryResponse } from "../types/api";
import { v4 as uuid } from "uuid";

const CODE_SESSION_PREFIX = "cse_";
const WEB_SESSION_PREFIX = "session_";
const CLOSED_SESSION_STATUSES = new Set(["archived", "inactive"]);

async function toResponse(row: { id: string; environmentId: string | null; title: string | null; status: string; source: string; permissionMode: string | null; workerEpoch: number; username: string | null; createdAt: Date; updatedAt: Date }): Promise<SessionResponse> {
  const env = row.environmentId ? await environmentRepo.getById(row.environmentId) : null;
  return {
    id: row.id,
    environment_id: row.environmentId,
    agent_name: env?.agentName ?? null,
    title: row.title,
    status: row.status,
    source: row.source,
    permission_mode: row.permissionMode,
    worker_epoch: row.workerEpoch,
    username: row.username,
    created_at: row.createdAt.getTime() / 1000,
    updated_at: row.updatedAt.getTime() / 1000,
  };
}

export function toWebSessionId(sessionId: string): string {
  if (!sessionId.startsWith(CODE_SESSION_PREFIX)) return sessionId;
  return `${WEB_SESSION_PREFIX}${sessionId.slice(CODE_SESSION_PREFIX.length)}`;
}

function toCompatibleCodeSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(WEB_SESSION_PREFIX)) return null;
  return `${CODE_SESSION_PREFIX}${sessionId.slice(WEB_SESSION_PREFIX.length)}`;
}

export async function toWebSessionResponse(session: SessionResponse): Promise<SessionResponse> {
  return { ...session, id: toWebSessionId(session.id) };
}

async function toWebSessionSummaryResponse(session: SessionSummaryResponse): Promise<SessionSummaryResponse> {
  return { ...session, id: toWebSessionId(session.id) };
}

export async function createSession(req: CreateSessionRequest & { username?: string }): Promise<SessionResponse> {
  const record = await sessionRepo.create({
    environmentId: req.environment_id,
    title: req.title,
    source: req.source,
    permissionMode: req.permission_mode,
    username: req.username,
    cwd: req.cwd,
  });
  return toResponse(record);
}

export async function createCodeSession(req: CreateCodeSessionRequest): Promise<SessionResponse> {
  const record = await sessionRepo.create({
    idPrefix: "cse_",
    title: req.title,
    source: req.source,
    permissionMode: req.permission_mode,
    cwd: req.cwd,
  });
  return toResponse(record);
}

export async function getSession(sessionId: string): Promise<SessionResponse | null> {
  const record = await sessionRepo.getById(sessionId);
  return record ? toResponse(record) : null;
}

export function isSessionClosedStatus(status: string | null | undefined): boolean {
  return !!status && CLOSED_SESSION_STATUSES.has(status);
}

export async function resolveExistingSessionId(sessionId: string): Promise<string | null> {
  if (await sessionRepo.getById(sessionId)) {
    return sessionId;
  }

  const compatibleCodeSessionId = toCompatibleCodeSessionId(sessionId);
  if (compatibleCodeSessionId && await sessionRepo.getById(compatibleCodeSessionId)) {
    return compatibleCodeSessionId;
  }

  return null;
}

export async function resolveExistingWebSessionId(sessionId: string): Promise<string | null> {
  return resolveExistingSessionId(sessionId);
}

export async function resolveOwnedWebSessionId(sessionId: string, uuid: string): Promise<string | null> {
  if (await sessionRepo.isOwner(sessionId, uuid)) {
    return sessionId;
  }

  const compatibleCodeSessionId = toCompatibleCodeSessionId(sessionId);
  if (compatibleCodeSessionId && await sessionRepo.isOwner(compatibleCodeSessionId, uuid)) {
    return compatibleCodeSessionId;
  }

  // Auto-bind: if the session exists but has no owner, claim it for the requesting user
  const existingId = await resolveExistingSessionId(sessionId);
  if (existingId) {
    const owners = await sessionRepo.getOwners(existingId);
    if (!owners || owners.size === 0) {
      await sessionRepo.bindOwner(existingId, uuid);
      return existingId;
    }
  }

  return null;
}

export async function listWebSessionsByOwnerUuid(uuid: string): Promise<SessionResponse[]> {
  const sessions = (await sessionRepo.listByOwnerUuid(uuid))
    .filter((session) => !isSessionClosedStatus(session.status));
  const results: SessionResponse[] = [];
  for (const s of sessions) {
    results.push(await toWebSessionResponse(await toResponse(s)));
  }
  return results;
}

export async function listWebSessionSummariesByOwnerUuid(uuid: string): Promise<SessionSummaryResponse[]> {
  return (await sessionRepo.listByOwnerUuid(uuid))
    .filter((session) => !isSessionClosedStatus(session.status))
    .map(toSummaryResponse)
    .map(toWebSessionSummaryResponse) as unknown as SessionSummaryResponse[];
}

export async function updateSessionTitle(sessionId: string, title: string) {
  await sessionRepo.update(sessionId, { title });
}

export async function updateSessionStatus(sessionId: string, status: string) {
  await sessionRepo.update(sessionId, { status });
  const bus = eventService.getAllBuses().get(sessionId);
  if (!bus) return;

  bus.publish({
    id: uuid(),
    sessionId,
    type: "session_status",
    payload: { status },
    direction: "inbound",
  });
}

export async function touchSession(sessionId: string) {
  await sessionRepo.update(sessionId, {});
}

export async function archiveSession(sessionId: string) {
  await updateSessionStatus(sessionId, "archived");
  eventService.removeBus(sessionId);
}

export async function incrementEpoch(sessionId: string): Promise<number> {
  const record = await sessionRepo.getById(sessionId);
  if (!record) throw new Error("Session not found");
  const newEpoch = record.workerEpoch + 1;
  await sessionRepo.update(sessionId, { workerEpoch: newEpoch });
  return newEpoch;
}

export async function listSessions() {
  const results: SessionResponse[] = [];
  for (const s of await sessionRepo.listAll()) {
    results.push(await toResponse(s));
  }
  return results;
}

function toSummaryResponse(row: { id: string; title: string | null; status: string; username: string | null; updatedAt: Date }): SessionSummaryResponse {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    username: row.username,
    updated_at: row.updatedAt.getTime() / 1000,
  };
}

export async function listSessionSummaries(): Promise<SessionSummaryResponse[]> {
  return (await sessionRepo.listAll()).map(toSummaryResponse);
}

export async function listSessionSummariesByOwnerUuid(uuid: string): Promise<SessionSummaryResponse[]> {
  return (await sessionRepo.listByOwnerUuid(uuid)).map(toSummaryResponse);
}

export async function listSessionSummariesByUsername(username: string): Promise<SessionSummaryResponse[]> {
  return (await sessionRepo.listByUsername(username)).map(toSummaryResponse);
}

export async function listSessionsByEnvironment(envId: string) {
  const results: SessionResponse[] = [];
  for (const s of await sessionRepo.listByEnvironment(envId)) {
    results.push(await toResponse(s));
  }
  return results;
}

/** Refresh session share mode based on active share links */
export async function refreshSessionShareMode(sessionId: string): Promise<void> {
  const links = await shareLinkRepo.listBySession(sessionId);
  const now = Date.now();
  let mode: "none" | "readonly" | "writable" = "none";
  for (const link of links) {
    const expired = link.expiresAt !== null && link.expiresAt.getTime() < now;
    if (!expired) {
      if (link.mode === "writable") { mode = "writable"; break; }
      if (link.mode === "readonly" && mode === "none") { mode = "readonly"; }
    }
  }
  sessionRepo.setShareMode(sessionId, mode);
  await sessionRepo.update(sessionId, { shareMode: mode });
}
