import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentInstance } from "../db/schema";

/** Agent Instance 的不可变创建来源。 */
export type InstanceCreationSource = "user" | "api" | "workflow";

/** 持久 Agent Instance 记录。 */
export interface AgentInstanceRecord {
  id: string;
  environmentId: string;
  ownerUserId: string;
  creationSource: InstanceCreationSource;
  name: string;
  isDefault: boolean;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentInstanceInput {
  id: string;
  environmentId: string;
  ownerUserId: string;
  creationSource: InstanceCreationSource;
  name: string;
  isDefault: boolean;
  createdByUserId: string | null;
}

/** Agent Instance 持久化边界。 */
export interface IAgentInstanceRepo {
  getById(instanceUid: string): Promise<AgentInstanceRecord | undefined>;
  findOwnedById(instanceUid: string, ownerUserId: string): Promise<AgentInstanceRecord | undefined>;
  findByCreationKey(
    environmentId: string,
    ownerUserId: string,
    creationSource: InstanceCreationSource,
    name: string,
  ): Promise<AgentInstanceRecord | undefined>;
  insert(input: CreateAgentInstanceInput): Promise<AgentInstanceRecord>;
  findOrCreateByCreationKey(input: CreateAgentInstanceInput): Promise<AgentInstanceRecord>;
  listByOwner(ownerUserId: string, environmentId?: string): Promise<AgentInstanceRecord[]>;
  listByEnvironment(environmentId: string): Promise<AgentInstanceRecord[]>;
  deleteById(instanceUid: string): Promise<boolean>;
}

class PgAgentInstanceRepo implements IAgentInstanceRepo {
  async getById(instanceUid: string): Promise<AgentInstanceRecord | undefined> {
    const [row] = await db.select().from(agentInstance).where(eq(agentInstance.id, instanceUid)).limit(1);
    return row;
  }

  async findOwnedById(instanceUid: string, ownerUserId: string): Promise<AgentInstanceRecord | undefined> {
    const [row] = await db
      .select()
      .from(agentInstance)
      .where(and(eq(agentInstance.id, instanceUid), eq(agentInstance.ownerUserId, ownerUserId)))
      .limit(1);
    return row;
  }

  async findByCreationKey(
    environmentId: string,
    ownerUserId: string,
    creationSource: InstanceCreationSource,
    name: string,
  ): Promise<AgentInstanceRecord | undefined> {
    const [row] = await db
      .select()
      .from(agentInstance)
      .where(
        and(
          eq(agentInstance.environmentId, environmentId),
          eq(agentInstance.ownerUserId, ownerUserId),
          eq(agentInstance.creationSource, creationSource),
          eq(agentInstance.name, name),
        ),
      )
      .limit(1);
    return row;
  }

  async insert(input: CreateAgentInstanceInput): Promise<AgentInstanceRecord> {
    const [row] = await db.insert(agentInstance).values(input).returning();
    if (!row) throw new Error("Agent Instance insert did not return a row");
    return row;
  }

  async findOrCreateByCreationKey(input: CreateAgentInstanceInput): Promise<AgentInstanceRecord> {
    const [created] = await db
      .insert(agentInstance)
      .values(input)
      .onConflictDoNothing({
        target: [
          agentInstance.environmentId,
          agentInstance.ownerUserId,
          agentInstance.creationSource,
          agentInstance.name,
        ],
      })
      .returning();
    if (created) return created;

    const existing = await this.findByCreationKey(
      input.environmentId,
      input.ownerUserId,
      input.creationSource,
      input.name,
    );
    if (existing) return existing;
    throw new Error("Agent Instance creation conflict did not resolve to a persisted row");
  }

  async listByOwner(ownerUserId: string, environmentId?: string): Promise<AgentInstanceRecord[]> {
    const condition = environmentId
      ? and(eq(agentInstance.ownerUserId, ownerUserId), eq(agentInstance.environmentId, environmentId))
      : eq(agentInstance.ownerUserId, ownerUserId);
    return db.select().from(agentInstance).where(condition);
  }

  async listByEnvironment(environmentId: string): Promise<AgentInstanceRecord[]> {
    return db.select().from(agentInstance).where(eq(agentInstance.environmentId, environmentId));
  }

  async deleteById(instanceUid: string): Promise<boolean> {
    const rows = await db
      .delete(agentInstance)
      .where(eq(agentInstance.id, instanceUid))
      .returning({ id: agentInstance.id });
    return rows.length > 0;
  }
}

export const agentInstanceRepo: IAgentInstanceRepo = new PgAgentInstanceRepo();
