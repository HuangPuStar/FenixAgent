import { v4 as uuid } from "uuid";

/** Session 持久化记录 */
export interface SessionRecord {
  id: string;
  environmentId: string | null;
  title: string | null;
  status: string;
  source: string;
  username: string | null;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionCreateParams {
  environmentId?: string | null;
  title?: string | null;
  source?: string;
  idPrefix?: string;
  username?: string | null;
  userId?: string | null;
}

/** Session 仓储接口 — 纯内存 Map */
export interface ISessionRepo {
  create(params: SessionCreateParams): Promise<SessionRecord>;
  getById(id: string): Promise<SessionRecord | undefined>;
  update(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "updatedAt">>): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  listAll(): Promise<SessionRecord[]>;
  listByEnvironment(envId: string): Promise<SessionRecord[]>;
  listByUserId(userId: string): Promise<SessionRecord[]>;
  bindOwner(sessionId: string, uuid: string): Promise<void>;
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
      username: params.username ?? null,
      userId: params.userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, record);
    return record;
  }

  async getById(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id);
  }

  async update(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "updatedAt">>): Promise<boolean> {
    const rec = this.sessions.get(id);
    if (!rec) return false;
    Object.assign(rec, patch, { updatedAt: new Date() });
    return true;
  }

  async delete(id: string): Promise<boolean> {
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

  async bindOwner(sessionId: string, uuid: string): Promise<void> {
    if (!this.sessionOwners.has(sessionId)) {
      this.sessionOwners.set(sessionId, new Set());
    }
    this.sessionOwners.get(sessionId)!.add(uuid);
  }

  reset(): void {
    this.sessions.clear();
    this.sessionOwners.clear();
  }
}

export const sessionRepo: ISessionRepo = new SessionRepo();
