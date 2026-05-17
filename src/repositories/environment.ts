import { v4 as uuid } from "uuid";
import { db } from "../db";
import { environment, user } from "../db/schema";
import { eq, and } from "drizzle-orm";

/** Environment 持久化记录 */
export interface EnvironmentRecord {
  id: string;
  name: string;
  description: string | null;
  workspacePath: string;
  agentConfigId: string | null;
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
  teamId: string | null;
  autoStart: boolean;
  lastPollAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentCreateParams {
  name?: string;
  description?: string;
  workspacePath?: string;
  agentConfigId?: string | null;
  secret?: string;
  userId: string;
  teamId?: string;
  status?: string;
  machineName?: string;
  directory?: string;
  branch?: string;
  gitRepoUrl?: string;
  maxSessions?: number;
  workerType?: string;
  username?: string;
  capabilities?: Record<string, unknown>;
  autoStart?: boolean;
}

export type EnvironmentUpdateParams = Partial<Pick<
  EnvironmentRecord,
  "status" | "lastPollAt" | "capabilities" | "machineName" | "maxSessions" |
  "name" | "description" | "workspacePath" | "agentConfigId" | "branch" | "gitRepoUrl" | "autoStart"
>>;

/** Environment 仓储接口 — PostgreSQL 持久化 */
export interface IEnvironmentRepo {
  create(params: EnvironmentCreateParams): Promise<EnvironmentRecord>;
  getById(id: string): Promise<EnvironmentRecord | undefined>;
  getBySecret(secret: string): Promise<EnvironmentRecord | undefined>;
  update(id: string, patch: EnvironmentUpdateParams): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  listActive(): Promise<EnvironmentRecord[]>;
  listAll(): Promise<EnvironmentRecord[]>;
  listByUserId(userId: string): Promise<EnvironmentRecord[]>;
  listActiveByUsername(username: string): Promise<EnvironmentRecord[]>;
  listAcpAgents(): Promise<EnvironmentRecord[]>;
  listAcpAgentsByUserId(userId: string): Promise<EnvironmentRecord[]>;
  listByTeamId(teamId: string): Promise<EnvironmentRecord[]>;
  listOnlineAcpAgents(): Promise<EnvironmentRecord[]>;
}

function rowToRecord(row: typeof environment.$inferSelect): EnvironmentRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    workspacePath: row.workspacePath,
    agentConfigId: row.agentConfigId ?? null,
    secret: row.secret,
    machineName: row.machineName,
    directory: row.workspacePath,
    branch: row.branch,
    gitRepoUrl: row.gitRepoUrl,
    maxSessions: row.maxSessions,
    workerType: row.workerType,
    capabilities: (row.capabilities as Record<string, unknown>) ?? null,
    status: row.status,
    username: null,
    userId: row.userId,
    teamId: (row as any).teamId ?? null,
    autoStart: row.autoStart ?? false,
    lastPollAt: row.lastPollAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class PgEnvironmentRepo implements IEnvironmentRepo {
  async create(params: EnvironmentCreateParams): Promise<EnvironmentRecord> {
    const id = `env_${uuid().replace(/-/g, "")}`;
    const now = new Date();
    const name = params.name || `env-${id.slice(4, 12)}`;
    const workspacePath = params.workspacePath || params.directory || "/tmp";
    const status = params.status || "active";
    const secret = params.secret || `sec_${uuid().replace(/-/g, "")}`;
    await db.insert(environment).values({
      id,
      name,
      description: params.description ?? null,
      workspacePath,
      agentConfigId: params.agentConfigId ?? null,
      secret,
      machineName: params.machineName ?? null,
      branch: params.branch ?? null,
      gitRepoUrl: params.gitRepoUrl ?? null,
      maxSessions: params.maxSessions ?? 1,
      workerType: params.workerType ?? "acp",
      capabilities: params.capabilities ?? null,
      status,
      userId: params.userId,
      teamId: (params as any).teamId ?? null,
      autoStart: params.autoStart ?? false,
      lastPollAt: now,
    } as any);
    return {
      id, name, description: params.description ?? null, workspacePath,
      agentConfigId: params.agentConfigId ?? null,
      secret,
      machineName: params.machineName ?? null,
      directory: params.directory ?? null,
      branch: params.branch ?? null, gitRepoUrl: params.gitRepoUrl ?? null,
      maxSessions: params.maxSessions ?? 1, workerType: params.workerType ?? "acp",
      capabilities: params.capabilities ?? null, status,
      username: params.username ?? null, userId: params.userId,
      teamId: (params as any).teamId ?? null,
      autoStart: params.autoStart ?? false,
      lastPollAt: now, createdAt: now, updatedAt: now,
    };
  }

  async getById(id: string): Promise<EnvironmentRecord | undefined> {
    const rows = await db.select().from(environment).where(eq(environment.id, id)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getBySecret(secret: string): Promise<EnvironmentRecord | undefined> {
    const rows = await db.select().from(environment).where(eq(environment.secret, secret)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async update(id: string, patch: EnvironmentUpdateParams): Promise<boolean> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.lastPollAt !== undefined) set.lastPollAt = patch.lastPollAt;
    if (patch.capabilities !== undefined) set.capabilities = patch.capabilities ?? null;
    if (patch.machineName !== undefined) set.machineName = patch.machineName;
    if (patch.maxSessions !== undefined) set.maxSessions = patch.maxSessions;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.workspacePath !== undefined) set.workspacePath = patch.workspacePath;
    if (patch.agentConfigId !== undefined) set.agentConfigId = patch.agentConfigId;
    if (patch.branch !== undefined) set.branch = patch.branch;
    if (patch.gitRepoUrl !== undefined) set.gitRepoUrl = patch.gitRepoUrl;
    if (patch.autoStart !== undefined) set.autoStart = patch.autoStart;
    const result = await db.update(environment).set(set).where(eq(environment.id, id));
    return (result as any).count > 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db.delete(environment).where(eq(environment.id, id));
    return (result as any).count > 0;
  }

  async listActive(): Promise<EnvironmentRecord[]> {
    const rows = await db.select().from(environment).where(eq(environment.status, "active"));
    return rows.map(rowToRecord);
  }

  async listAll(): Promise<EnvironmentRecord[]> {
    const rows = await db.select().from(environment);
    return rows.map(rowToRecord);
  }

  async listByUserId(userId: string): Promise<EnvironmentRecord[]> {
    const rows = await db.select().from(environment).where(eq(environment.userId, userId));
    return rows.map(rowToRecord);
  }

  async listActiveByUsername(username: string): Promise<EnvironmentRecord[]> {
    const userRow = await db.select().from(user).where(eq(user.name, username)).limit(1);
    if (userRow.length === 0) return [];
    const rows = await db.select().from(environment).where(
      and(eq(environment.status, "active"), eq(environment.userId, userRow[0].id))
    );
    return rows.map(rowToRecord);
  }

  async listAcpAgents(): Promise<EnvironmentRecord[]> {
    const rows = await db.select().from(environment).where(eq(environment.workerType, "acp"));
    return rows.map(rowToRecord);
  }

  async listAcpAgentsByUserId(userId: string): Promise<EnvironmentRecord[]> {
    const rows = await db.select().from(environment).where(
      and(eq(environment.workerType, "acp"), eq(environment.userId, userId))
    );
    return rows.map(rowToRecord);
  }

  async listByTeamId(teamId: string): Promise<EnvironmentRecord[]> {
    const rows = await db.select().from(environment).where(eq(environment.teamId, teamId));
    return rows.map(rowToRecord);
  }

  async listOnlineAcpAgents(): Promise<EnvironmentRecord[]> {
    const rows = await db.select().from(environment).where(
      and(eq(environment.workerType, "acp"), eq(environment.status, "active"))
    );
    return rows.map(rowToRecord);
  }
}

export const environmentRepo: IEnvironmentRepo = new PgEnvironmentRepo();
