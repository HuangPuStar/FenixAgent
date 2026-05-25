import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { agentSession } from "../db/schema";

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

/** Session 仓储接口 — PostgreSQL 持久化 */
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

function rowToRecord(row: typeof agentSession.$inferSelect): SessionRecord {
  return {
    id: row.id,
    environmentId: row.environmentId ?? null,
    title: row.title ?? null,
    status: row.status,
    source: row.source,
    username: null,
    userId: row.userId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class PgSessionRepo implements ISessionRepo {
  private sessionOwners = new Map<string, Set<string>>();

  async create(params: SessionCreateParams): Promise<SessionRecord> {
    const id = `${params.idPrefix || "session_"}${uuid().replace(/-/g, "")}`;
    const now = new Date();
    await db.insert(agentSession).values({
      id,
      environmentId: params.environmentId ?? null,
      title: params.title ?? null,
      status: "idle",
      source: params.source ?? "acp",
      userId: params.userId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return {
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
  }

  async getById(id: string): Promise<SessionRecord | undefined> {
    const rows = await db.select().from(agentSession).where(eq(agentSession.id, id)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async update(id: string, patch: Partial<Pick<SessionRecord, "title" | "status" | "updatedAt">>): Promise<boolean> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.status !== undefined) set.status = patch.status;
    const result = await db.update(agentSession).set(set).where(eq(agentSession.id, id));
    return (result as unknown as { count: number }).count > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db.delete(agentSession).where(eq(agentSession.id, id));
    return (result as unknown as { count: number }).count > 0;
  }

  async listAll(): Promise<SessionRecord[]> {
    const rows = await db.select().from(agentSession);
    return rows.map(rowToRecord);
  }

  async listByEnvironment(envId: string): Promise<SessionRecord[]> {
    const rows = await db.select().from(agentSession).where(eq(agentSession.environmentId, envId));
    return rows.map(rowToRecord);
  }

  async listByUserId(userId: string): Promise<SessionRecord[]> {
    const rows = await db.select().from(agentSession).where(eq(agentSession.userId, userId));
    return rows.map(rowToRecord);
  }

  async bindOwner(sessionId: string, uuid: string): Promise<void> {
    if (!this.sessionOwners.has(sessionId)) {
      this.sessionOwners.set(sessionId, new Set());
    }
    this.sessionOwners.get(sessionId)!.add(uuid);
  }

  reset(): void {
    this.sessionOwners.clear();
  }
}

export const sessionRepo: ISessionRepo = new PgSessionRepo();
