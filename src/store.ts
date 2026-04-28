import { v4 as uuid } from "uuid";
import { db, sqlite } from "./db";
import { environment, user, shareLink, shareEventSnapshot } from "./db/schema";
import { eq, and, isNull, gt, or, sql } from "drizzle-orm";

// ---------- Types ----------

export interface EnvironmentRecord {
  id: string;
  name: string;
  description: string | null;
  workspacePath: string;
  agentName: string | null;
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
  shareMode: "none" | "readonly" | "writable";
  createdAt: Date;
  updatedAt: Date;
}

// ---------- Stores (in-memory Maps) ----------

const sessions = new Map<string, SessionRecord>();

// ---------- Environment (SQLite) ----------

function rowToRecord(row: typeof environment.$inferSelect): EnvironmentRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    workspacePath: row.workspacePath,
    agentName: row.agentName,
    secret: row.secret,
    machineName: row.machineName,
    directory: row.workspacePath,
    branch: row.branch,
    gitRepoUrl: row.gitRepoUrl,
    maxSessions: row.maxSessions,
    workerType: row.workerType,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : null,
    status: row.status,
    username: null,
    userId: row.userId,
    lastPollAt: row.lastPollAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function storeCreateEnvironment(req: {
  name?: string;
  description?: string;
  workspacePath?: string;
  agentName?: string;
  secret?: string;
  userId: string;
  status?: string;
  machineName?: string;
  directory?: string;
  branch?: string;
  gitRepoUrl?: string;
  maxSessions?: number;
  workerType?: string;
  username?: string;
  capabilities?: Record<string, unknown>;
}): EnvironmentRecord {
  const id = `env_${uuid().replace(/-/g, "")}`;
  const now = new Date();
  const name = req.name || `env-${id.slice(4, 12)}`;
  const workspacePath = req.workspacePath || req.directory || "/tmp";
  const status = req.status || "active";
  const secret = req.secret || `sec_${uuid().replace(/-/g, "")}`;
  db.insert(environment).values({
    id,
    name,
    description: req.description ?? null,
    workspacePath,
    agentName: req.agentName ?? null,
    secret,
    machineName: req.machineName ?? null,
    branch: req.branch ?? null,
    gitRepoUrl: req.gitRepoUrl ?? null,
    maxSessions: req.maxSessions ?? 1,
    workerType: req.workerType ?? "acp",
    capabilities: req.capabilities ? JSON.stringify(req.capabilities) : null,
    status,
    userId: req.userId,
    lastPollAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
  return {
    id, name, description: req.description ?? null, workspacePath,
    agentName: req.agentName ?? null, secret,
    machineName: req.machineName ?? null, directory: req.directory ?? null,
    branch: req.branch ?? null, gitRepoUrl: req.gitRepoUrl ?? null,
    maxSessions: req.maxSessions ?? 1, workerType: req.workerType ?? "acp",
    capabilities: req.capabilities ?? null, status,
    username: req.username ?? null, userId: req.userId,
    lastPollAt: now, createdAt: now, updatedAt: now,
  };
}

export function storeGetEnvironment(id: string): EnvironmentRecord | undefined {
  const rows = db.select().from(environment).where(eq(environment.id, id)).limit(1).all();
  return rows[0] ? rowToRecord(rows[0]) : undefined;
}

export function storeGetEnvironmentBySecret(secret: string): EnvironmentRecord | undefined {
  const rows = db.select().from(environment).where(eq(environment.secret, secret)).limit(1).all();
  return rows[0] ? rowToRecord(rows[0]) : undefined;
}

export function storeUpdateEnvironment(id: string, patch: Partial<Pick<EnvironmentRecord, "status" | "lastPollAt" | "updatedAt" | "capabilities" | "machineName" | "maxSessions" | "name" | "description" | "workspacePath" | "agentName" | "branch" | "gitRepoUrl">>): boolean {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.lastPollAt !== undefined) set.lastPollAt = patch.lastPollAt;
  if (patch.capabilities !== undefined) set.capabilities = patch.capabilities ? JSON.stringify(patch.capabilities) : null;
  if (patch.machineName !== undefined) set.machineName = patch.machineName;
  if (patch.maxSessions !== undefined) set.maxSessions = patch.maxSessions;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.workspacePath !== undefined) set.workspacePath = patch.workspacePath;
  if (patch.agentName !== undefined) set.agentName = patch.agentName;
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.gitRepoUrl !== undefined) set.gitRepoUrl = patch.gitRepoUrl;
  db.update(environment).set(set).where(eq(environment.id, id)).run();
  const changes = (sqlite.query("SELECT changes() as c").get() as { c: number }).c;
  return changes > 0;
}

export function storeListActiveEnvironments(): EnvironmentRecord[] {
  return db.select().from(environment).where(eq(environment.status, "active")).all().map(rowToRecord);
}

export function storeListEnvironmentsByUserId(userId: string): EnvironmentRecord[] {
  return db.select().from(environment).where(eq(environment.userId, userId)).all().map(rowToRecord);
}

export function storeListActiveEnvironmentsByUsername(username: string): EnvironmentRecord[] {
  const userRow = db.select().from(user).where(eq(user.name, username)).limit(1).all();
  if (userRow.length === 0) return [];
  return db.select().from(environment).where(and(eq(environment.status, "active"), eq(environment.userId, userRow[0].id))).all().map(rowToRecord);
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
    shareMode: "none" as const,
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

export function storeListSessionsForAgentByCwd(agentId: string, cwd?: string): SessionRecord[] {
  const env = storeGetEnvironment(agentId);
  if (!env) return [];
  if (cwd) {
    const normalizedCwd = cwd.endsWith("/") ? cwd : cwd + "/";
    const normalizedWp = env.workspacePath.endsWith("/") ? env.workspacePath : env.workspacePath + "/";
    if (env.workspacePath !== cwd && !normalizedWp.startsWith(normalizedCwd)) {
      return [];
    }
  }
  return storeListSessionsByEnvironment(agentId);
}

export function storeDeleteSession(id: string): boolean {
  return sessions.delete(id);
}

// ---------- Share Link ----------

export function storeCreateShareLink(
  sessionId: string,
  environmentId: string,
  mode: string,
  expiresAt: Date | null,
  createdBy: string,
) {
  const id = `share_${uuid().replace(/-/g, "")}`;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const now = new Date();
  db.insert(shareLink).values({
    id,
    sessionId,
    environmentId,
    token,
    mode: mode as "readonly" | "writable",
    expiresAt,
    createdBy,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run();
  return { id, sessionId, environmentId, token, mode, expiresAt, createdBy, accessCount: 0, lastAccessedAt: null as Date | null, createdAt: now, updatedAt: now };
}

export function storeGetShareLink(id: string) {
  const rows = db.select().from(shareLink).where(eq(shareLink.id, id)).limit(1).all();
  return rows[0] ?? undefined;
}

export function storeGetShareLinkByToken(token: string) {
  const rows = db.select().from(shareLink).where(eq(shareLink.token, token)).limit(1).all();
  return rows[0] ?? undefined;
}

export function storeListShareLinksBySession(sessionId: string) {
  return db.select().from(shareLink).where(eq(shareLink.sessionId, sessionId)).all();
}

export function storeDeleteShareLink(id: string): boolean {
  db.delete(shareLink).where(eq(shareLink.id, id)).run();
  const changes = (sqlite.query("SELECT changes() as c").get() as { c: number }).c;
  return changes > 0;
}

export function storeUpdateShareLinkAccess(id: string): void {
  db.update(shareLink).set({
    accessCount: sql`${shareLink.accessCount} + 1`,
    lastAccessedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(shareLink.id, id)).run();
}

export function storeRefreshSessionShareMode(sessionId: string): void {
  const links = db.select().from(shareLink).where(eq(shareLink.sessionId, sessionId)).all();
  const now = Date.now();
  let mode: "none" | "readonly" | "writable" = "none";
  for (const link of links) {
    const expired = link.expiresAt !== null && link.expiresAt.getTime() < now;
    if (!expired) {
      if (link.mode === "writable") { mode = "writable"; break; }
      if (link.mode === "readonly" && mode === "none") { mode = "readonly"; }
    }
  }
  const rec = sessions.get(sessionId);
  if (rec) rec.shareMode = mode;
}

// ---------- Share Event Snapshot ----------

/** Persist an event snapshot for a share link (overwrites previous) */
export function storeSaveEventSnapshot(shareLinkId: string, eventsJson: string): void {
  // Delete previous snapshot
  db.delete(shareEventSnapshot).where(eq(shareEventSnapshot.shareLinkId, shareLinkId)).run();
  db.insert(shareEventSnapshot).values({
    id: `snap_${uuid().replace(/-/g, "")}`,
    shareLinkId,
    events: eventsJson,
    createdAt: new Date(),
  }).run();
}

/** Load the event snapshot for a share link (returns null if none) */
export function storeGetEventSnapshot(shareLinkId: string): string | null {
  const rows = db.select({ events: shareEventSnapshot.events })
    .from(shareEventSnapshot)
    .where(eq(shareEventSnapshot.shareLinkId, shareLinkId))
    .limit(1).all();
  return rows.length > 0 ? rows[0].events : null;
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

/** Delete an environment and its associated sessions */
export function storeDeleteEnvironment(id: string): boolean {
  // Delete associated in-memory sessions first
  for (const [sid, s] of sessions) {
    if (s.environmentId === id) sessions.delete(sid);
  }
  db.delete(environment).where(eq(environment.id, id)).run();
  const changes = (sqlite.query("SELECT changes() as c").get() as { c: number }).c;
  return changes > 0;
}

// ---------- ACP Agent (reuses EnvironmentRecord with workerType="acp") ----------

/** List all ACP agents (environments with workerType="acp") */
export function storeListAcpAgents(): EnvironmentRecord[] {
  return db.select().from(environment).where(eq(environment.workerType, "acp")).all().map(rowToRecord);
}

/** List ACP agents for a specific user */
export function storeListAcpAgentsByUserId(userId: string): EnvironmentRecord[] {
  return db.select().from(environment).where(and(eq(environment.workerType, "acp"), eq(environment.userId, userId))).all().map(rowToRecord);
}

/** List online ACP agents */
export function storeListOnlineAcpAgents(): EnvironmentRecord[] {
  return db.select().from(environment).where(and(eq(environment.workerType, "acp"), eq(environment.status, "active"))).all().map(rowToRecord);
}

// ---------- Session Workers ----------

export interface SessionWorkerRecord {
  sessionId: string;
  workerStatus: string | null;
  externalMetadata: Record<string, unknown> | null;
  requiresActionDetails: Record<string, unknown> | null;
  lastHeartbeatAt: Date | null;
}

const sessionWorkers = new Map<string, SessionWorkerRecord>();

export function storeGetSessionWorker(sessionId: string): SessionWorkerRecord | undefined {
  return sessionWorkers.get(sessionId);
}

export function storeUpsertSessionWorker(
  sessionId: string,
  patch: Partial<Omit<SessionWorkerRecord, "sessionId">>,
): SessionWorkerRecord {
  let record = sessionWorkers.get(sessionId);
  if (!record) {
    record = {
      sessionId,
      workerStatus: null,
      externalMetadata: null,
      requiresActionDetails: null,
      lastHeartbeatAt: null,
    };
    sessionWorkers.set(sessionId, record);
  }
  Object.assign(record, patch);
  return record;
}

// ---------- Token Store (legacy) ----------

const tokens = new Map<string, { username: string; createdAt: Date }>();

export function storeCreateToken(username: string, token: string): void {
  tokens.set(token, { username, createdAt: new Date() });
}

export function storeGetUserByToken(token: string): { username: string } | undefined {
  return tokens.get(token);
}

// ---------- Reset (for tests) ----------

export function storeReset() {
  sessions.clear();
  sessionWorkers.clear();
  tokens.clear();
}
