import { v4 as uuid } from "uuid";
import { db } from "../db";
import { agentSession } from "../db/schema";
import { eq } from "drizzle-orm";

/** Session 持久化记录 */
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
  cwd: string | null;
  shareMode: "none" | "readonly" | "writable";
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionCreateParams {
  environmentId?: string | null;
  title?: string | null;
  source?: string;
  permissionMode?: string | null;
  idPrefix?: string;
  username?: string | null;
  userId?: string | null;
  cwd?: string | null;
}

/** Session 仓储接口 — 内存 Map + PostgreSQL 双写 */
export interface ISessionRepo {
  create(params: SessionCreateParams): Promise<SessionRecord>;
  getById(id: string): Promise<SessionRecord | undefined>;
  update(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "workerEpoch" | "updatedAt" | "shareMode">>): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  listAll(): Promise<SessionRecord[]>;
  listByEnvironment(envId: string): Promise<SessionRecord[]>;
  listByUserId(userId: string): Promise<SessionRecord[]>;
  listForAgentByCwd(agentId: string, cwd?: string): Promise<SessionRecord[]>;
  listByOwnerUuid(uuid: string): Promise<SessionRecord[]>;
  listByUsername(username: string): Promise<SessionRecord[]>;
  dissociateFromEnvironment(environmentId: string): Promise<void>;
  loadFromDB(): Promise<void>;
  bindOwner(sessionId: string, uuid: string): Promise<void>;
  isOwner(sessionId: string, uuid: string): Promise<boolean>;
  getOwners(sessionId: string): Promise<Set<string> | undefined>;
  setShareMode(sessionId: string, mode: "none" | "readonly" | "writable"): void;
  reset(): void;
}

class SessionRepo implements ISessionRepo {
  private sessions = new Map<string, SessionRecord>();
  private sessionOwners = new Map<string, Set<string>>();

  async create(params: SessionCreateParams): Promise<SessionRecord> {
    const id = `${params.idPrefix || "session_"}${uuid().replace(/-/g, "")}`;
    const now = new Date();
    const record: SessionRecord = {
      id,
      environmentId: params.environmentId ?? null,
      title: params.title ?? null,
      status: "idle",
      source: params.source ?? "acp",
      permissionMode: params.permissionMode ?? null,
      workerEpoch: 0,
      username: params.username ?? null,
      userId: params.userId ?? null,
      cwd: params.cwd ?? null,
      shareMode: "none" as const,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, record);
    await db.insert(agentSession).values({
      id,
      environmentId: record.environmentId,
      title: record.title,
      status: record.status,
      source: record.source,
      permissionMode: record.permissionMode,
      workerEpoch: record.workerEpoch,
      username: record.username,
      userId: record.userId,
      cwd: record.cwd,
      shareMode: record.shareMode,
    });
    return record;
  }

  async getById(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id);
  }

  async update(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "workerEpoch" | "updatedAt" | "shareMode">>): Promise<boolean> {
    const rec = this.sessions.get(id);
    if (!rec) return false;
    Object.assign(rec, patch, { updatedAt: new Date() });
    const dbSet: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) dbSet.title = patch.title;
    if (patch.status !== undefined) dbSet.status = patch.status;
    if (patch.workerEpoch !== undefined) dbSet.workerEpoch = patch.workerEpoch;
    if (patch.shareMode !== undefined) dbSet.shareMode = patch.shareMode;
    await db.update(agentSession).set(dbSet).where(eq(agentSession.id, id));
    return true;
  }

  async delete(id: string): Promise<boolean> {
    await db.delete(agentSession).where(eq(agentSession.id, id));
    return this.sessions.delete(id);
  }

  async listAll(): Promise<SessionRecord[]> {
    return [...this.sessions.values()];
  }

  async listByEnvironment(envId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()].filter((s) => s.environmentId === envId);
  }

  async listByUserId(userId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()].filter((s) => s.userId === userId);
  }

  async listForAgentByCwd(agentId: string, _cwd?: string): Promise<SessionRecord[]> {
    return this.listByEnvironment(agentId);
  }

  async listByOwnerUuid(uuid: string): Promise<SessionRecord[]> {
    const ownedIds = new Set<string>();
    for (const [sid, owners] of this.sessionOwners) {
      if (owners.has(uuid)) ownedIds.add(sid);
    }
    return [...this.sessions.values()].filter((s) => ownedIds.has(s.id));
  }

  async listByUsername(username: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()].filter((s) => s.username === username);
  }

  async dissociateFromEnvironment(environmentId: string): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.environmentId === environmentId) {
        s.environmentId = null;
        await db.update(agentSession).set({ environmentId: null, updatedAt: new Date() }).where(eq(agentSession.id, s.id));
      }
    }
  }

  async loadFromDB(): Promise<void> {
    const rows = await db.select().from(agentSession);
    for (const row of rows) {
      this.sessions.set(row.id, {
        id: row.id,
        environmentId: row.environmentId,
        title: row.title,
        status: row.status,
        source: row.source,
        permissionMode: row.permissionMode,
        workerEpoch: row.workerEpoch,
        username: row.username,
        userId: row.userId,
        cwd: row.cwd,
        shareMode: (row.shareMode as "none" | "readonly" | "writable") ?? "none",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  }

  async bindOwner(sessionId: string, uuid: string): Promise<void> {
    if (!this.sessionOwners.has(sessionId)) {
      this.sessionOwners.set(sessionId, new Set());
    }
    this.sessionOwners.get(sessionId)!.add(uuid);
  }

  async isOwner(sessionId: string, uuid: string): Promise<boolean> {
    return this.sessionOwners.get(sessionId)?.has(uuid) ?? false;
  }

  async getOwners(sessionId: string): Promise<Set<string> | undefined> {
    return this.sessionOwners.get(sessionId);
  }

  setShareMode(sessionId: string, mode: "none" | "readonly" | "writable"): void {
    const rec = this.sessions.get(sessionId);
    if (rec) rec.shareMode = mode;
  }

  reset(): void {
    this.sessions.clear();
    this.sessionOwners.clear();
  }
}

export const sessionRepo: ISessionRepo = new SessionRepo();
