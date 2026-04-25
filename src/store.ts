import { v4 as uuid } from "uuid";

// ---------- Types ----------

export interface EnvironmentRecord {
  id: string;
  secret: string;
  machineName: string | null;
  directory: string | null;
  branch: string | null;
  gitRepoUrl: string | null;
  maxSessions: number;
  workerType: string;
  capabilities: Record<string, unknown> | null;
  status: string;
  username: string | null;
  userId: string | null;
  lastPollAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  environmentId: string | null;
  title: string | null;
  status: string;
  source: string;
  permissionMode: string | null;
  workerEpoch: number;
  username: string | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------- Stores (in-memory Maps) ----------

const environments = new Map<string, EnvironmentRecord>();
const sessions = new Map<string, SessionRecord>();

// ---------- Environment ----------

/** Find an active or offline environment by machineName and userId.
 *  Includes "offline" so ACP agents can be reused on reconnect. */
export function storeFindEnvironmentByMachineName(
  machineName: string,
  userId: string,
): EnvironmentRecord | undefined {
  for (const rec of environments.values()) {
    if (
      rec.machineName === machineName &&
      rec.userId === userId &&
      (rec.status === "active" || rec.status === "offline")
    ) {
      return rec;
    }
  }
  return undefined;
}

export function storeCreateEnvironment(req: {
  secret: string;
  userId: string;
  machineName?: string;
  directory?: string;
  branch?: string;
  gitRepoUrl?: string;
  maxSessions?: number;
  workerType?: string;
  username?: string;
  capabilities?: Record<string, unknown>;
}): EnvironmentRecord {
  // ACP: reuse existing active record by machineName + userId
  if (req.workerType === "acp" && req.machineName) {
    const existing = storeFindEnvironmentByMachineName(req.machineName, req.userId);
    if (existing) {
      Object.assign(existing, {
        status: "active",
        lastPollAt: new Date(),
        updatedAt: new Date(),
        maxSessions: req.maxSessions ?? existing.maxSessions,
        capabilities: req.capabilities ?? existing.capabilities,
        username: req.username ?? existing.username,
      });
      return existing;
    }
  }

  const id = `env_${uuid().replace(/-/g, "")}`;
  const now = new Date();
  const record: EnvironmentRecord = {
    id,
    secret: req.secret,
    machineName: req.machineName ?? null,
    directory: req.directory ?? null,
    branch: req.branch ?? null,
    gitRepoUrl: req.gitRepoUrl ?? null,
    maxSessions: req.maxSessions ?? 1,
    workerType: req.workerType ?? "acp",
    capabilities: req.capabilities ?? null,
    status: "active",
    username: req.username ?? null,
    userId: req.userId,
    lastPollAt: now,
    createdAt: now,
    updatedAt: now,
  };
  environments.set(id, record);
  return record;
}

export function storeGetEnvironment(id: string): EnvironmentRecord | undefined {
  return environments.get(id);
}

export function storeUpdateEnvironment(id: string, patch: Partial<Pick<EnvironmentRecord, "status" | "lastPollAt" | "updatedAt" | "capabilities" | "machineName" | "maxSessions">>): boolean {
  const rec = environments.get(id);
  if (!rec) return false;
  Object.assign(rec, patch, { updatedAt: new Date() });
  return true;
}

export function storeListActiveEnvironments(): EnvironmentRecord[] {
  return [...environments.values()].filter((e) => e.status === "active");
}

export function storeListEnvironmentsByUserId(userId: string): EnvironmentRecord[] {
  return [...environments.values()].filter((e) => e.userId === userId);
}

export function storeListActiveEnvironmentsByUsername(username: string): EnvironmentRecord[] {
  return [...environments.values()].filter(
    (e) => e.status === "active" && e.username === username,
  );
}

// ---------- Session ----------

export function storeCreateSession(req: {
  environmentId?: string | null;
  title?: string | null;
  source?: string;
  permissionMode?: string | null;
  idPrefix?: string;
  username?: string | null;
  userId?: string | null;
}): SessionRecord {
  const id = `${req.idPrefix || "session_"}${uuid().replace(/-/g, "")}`;
  const now = new Date();
  const record: SessionRecord = {
    id,
    environmentId: req.environmentId ?? null,
    title: req.title ?? null,
    status: "idle",
    source: req.source ?? "acp",
    permissionMode: req.permissionMode ?? null,
    workerEpoch: 0,
    username: req.username ?? null,
    userId: req.userId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(id, record);
  return record;
}

export function storeGetSession(id: string): SessionRecord | undefined {
  return sessions.get(id);
}

export function storeUpdateSession(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "workerEpoch" | "updatedAt">>): boolean {
  const rec = sessions.get(id);
  if (!rec) return false;
  Object.assign(rec, patch, { updatedAt: new Date() });
  return true;
}

export function storeListSessions(): SessionRecord[] {
  return [...sessions.values()];
}

export function storeListSessionsByEnvironment(envId: string): SessionRecord[] {
  return [...sessions.values()].filter((s) => s.environmentId === envId);
}

export function storeListSessionsByUserId(userId: string): SessionRecord[] {
  return [...sessions.values()].filter((s) => s.userId === userId);
}

export function storeDeleteSession(id: string): boolean {
  return sessions.delete(id);
}

// ---------- Session Ownership (UUID-based) ----------

const sessionOwners = new Map<string, Set<string>>();

export function storeBindSession(sessionId: string, uuid: string): void {
  if (!sessionOwners.has(sessionId)) {
    sessionOwners.set(sessionId, new Set());
  }
  sessionOwners.get(sessionId)!.add(uuid);
}

export function storeIsSessionOwner(sessionId: string, uuid: string): boolean {
  return sessionOwners.get(sessionId)?.has(uuid) ?? false;
}

export function storeGetSessionOwners(sessionId: string): Set<string> | undefined {
  return sessionOwners.get(sessionId);
}

export function storeListSessionsByOwnerUuid(uuid: string): SessionRecord[] {
  const ownedIds = new Set<string>();
  for (const [sid, owners] of sessionOwners) {
    if (owners.has(uuid)) ownedIds.add(sid);
  }
  return [...sessions.values()].filter((s) => ownedIds.has(s.id));
}

export function storeListSessionsByUsername(username: string): SessionRecord[] {
  return [...sessions.values()].filter((s) => s.username === username);
}

// ---------- Work Items ----------

export interface WorkItemRecord {
  id: string;
  environmentId: string;
  sessionId: string;
  secret: string;
  state: string;
  createdAt: Date;
  updatedAt: Date;
}

const workItems = new Map<string, WorkItemRecord>();

export function storeCreateWorkItem(req: {
  environmentId: string;
  sessionId: string;
  secret: string;
}): WorkItemRecord {
  const id = `work_${uuid().replace(/-/g, "")}`;
  const now = new Date();
  const record: WorkItemRecord = {
    id,
    environmentId: req.environmentId,
    sessionId: req.sessionId,
    secret: req.secret,
    state: "pending",
    createdAt: now,
    updatedAt: now,
  };
  workItems.set(id, record);
  return record;
}

export function storeGetWorkItem(id: string): WorkItemRecord | undefined {
  return workItems.get(id);
}

export function storeGetPendingWorkItem(environmentId: string): WorkItemRecord | undefined {
  for (const item of workItems.values()) {
    if (item.environmentId === environmentId && item.state === "pending") {
      return item;
    }
  }
  return undefined;
}

export function storeUpdateWorkItem(id: string, patch: Partial<Pick<WorkItemRecord, "state">>): boolean {
  const item = workItems.get(id);
  if (!item) return false;
  Object.assign(item, patch, { updatedAt: new Date() });
  return true;
}

// ---------- ACP Agent (reuses EnvironmentRecord with workerType="acp") ----------

/** List all ACP agents (environments with workerType="acp") */
export function storeListAcpAgents(): EnvironmentRecord[] {
  return [...environments.values()].filter((e) => e.workerType === "acp");
}

/** List ACP agents for a specific user */
export function storeListAcpAgentsByUserId(userId: string): EnvironmentRecord[] {
  return [...environments.values()].filter(
    (e) => e.workerType === "acp" && e.userId === userId,
  );
}

/** List online ACP agents */
export function storeListOnlineAcpAgents(): EnvironmentRecord[] {
  return [...environments.values()].filter(
    (e) => e.workerType === "acp" && e.status === "active",
  );
}

/** Mark an ACP agent as offline */
export function storeMarkAcpAgentOffline(id: string): boolean {
  const rec = environments.get(id);
  if (!rec || rec.workerType !== "acp") return false;
  Object.assign(rec, { status: "offline", updatedAt: new Date() });
  return true;
}

/** Mark an ACP agent as online (on reconnect) */
export function storeMarkAcpAgentOnline(id: string): boolean {
  const rec = environments.get(id);
  if (!rec || rec.workerType !== "acp") return false;
  Object.assign(rec, { status: "active", lastPollAt: new Date(), updatedAt: new Date() });
  return true;
}

// ---------- Reset (for tests) ----------

export function storeReset() {
  environments.clear();
  sessions.clear();
}
