import { db } from "../db";
import { channelBinding } from "../db/schema";
import { eq, and } from "drizzle-orm";

/** ChannelBinding 行类型 */
export type ChannelBindingRow = typeof channelBinding.$inferSelect;
export type ChannelBindingInsert = typeof channelBinding.$inferInsert;

/** ChannelBinding 仓储接口 */
export interface IChannelBindingRepo {
  list(): Promise<ChannelBindingRow[]>;
  getById(bindingId: string): Promise<ChannelBindingRow | null>;
  create(data: ChannelBindingInsert): Promise<ChannelBindingRow>;
  delete(bindingId: string): Promise<boolean>;
  findByChannelAndAgent(channelId: string, agentId: string): Promise<ChannelBindingRow | null>;
  update(bindingId: string, data: Partial<ChannelBindingInsert>): Promise<void>;
  listByPlatformAndEnabled(platform: string): Promise<ChannelBindingRow[]>;
}

class PgChannelBindingRepo implements IChannelBindingRepo {
  async list() {
    return db.select().from(channelBinding);
  }

  async getById(bindingId: string) {
    const rows = await db.select().from(channelBinding).where(eq(channelBinding.id, bindingId)).limit(1);
    return rows[0] ?? null;
  }

  async create(data: ChannelBindingInsert) {
    const [row] = await db.insert(channelBinding).values(data).returning();
    return row;
  }

  async delete(bindingId: string): Promise<boolean> {
    const result = await db.delete(channelBinding).where(eq(channelBinding.id, bindingId)).returning({ id: channelBinding.id });
    return result.length > 0;
  }

  async findByChannelAndAgent(channelId: string, agentId: string) {
    const rows = await db.select().from(channelBinding)
      .where(and(eq(channelBinding.id, channelId), eq(channelBinding.agentId, agentId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async update(bindingId: string, data: Partial<ChannelBindingInsert>) {
    await db.update(channelBinding).set(data).where(eq(channelBinding.id, bindingId));
  }

  async listByPlatformAndEnabled(platform: string) {
    return db.select().from(channelBinding)
      .where(and(eq(channelBinding.platform, platform), eq(channelBinding.enabled, true)));
  }
}

export const channelBindingRepo = new PgChannelBindingRepo();
